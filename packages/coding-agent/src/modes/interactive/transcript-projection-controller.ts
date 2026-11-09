/**
 * The host side of transcript projection: snapshot building, projection requests, validation, caching,
 * fallback reporting and per-span reveal state, free of UI so the render path can call it directly.
 */

import type { SessionEntry } from "../../core/session-manager.ts";
import {
	fallbackReason,
	type RejectedTranscriptProjection,
	type ResolvedItem,
	type TranscriptProjection,
	type TranscriptProjectionProvider,
	type TranscriptSnapshot,
	type TranscriptSnapshotEntry,
	validateTranscriptProjection,
} from "../../core/transcript-projection.ts";

/** Built-in action that reveals the raw entries a span covers. Never reaches the provider. */
export const REVEAL_ORIGINALS_ACTION = "reveal-originals";
/** Built-in action that collapses a revealed span. Never reaches the provider. */
export const COLLAPSE_ACTION = "collapse";

/** A provider was registered, replaced or removed, or the active provider asked to project again. */
export type TranscriptProjectionSourceEvent = { readonly kind: "provider" | "invalidate" };

/** What the controller needs from the session: the current provider and its change notifications. */
export interface TranscriptProjectionSource {
	getProvider(): TranscriptProjectionProvider | undefined;
	subscribe(listener: (event: TranscriptProjectionSourceEvent) => void): () => void;
}

/** Timer primitives, injectable so tests own timeouts and refresh coalescing. */
export interface TranscriptProjectionTimers {
	set(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
	clear(handle: ReturnType<typeof setTimeout>): void;
}

/** Everything the controller needs from its host. */
export interface TranscriptProjectionControllerDeps {
	source: TranscriptProjectionSource;
	/** Report a rejected, thrown or timed-out projection, and a failed provider action. */
	warn(message: string): void;
	/** Rebuild the transcript from `resolve()`; called once per settled projection and on invalidation. */
	onRefresh(): void;
	/** Milliseconds a projection may take before the view falls back. Defaults to 2000. */
	timeoutMs?: number;
	timers?: TranscriptProjectionTimers;
}

/** What the transcript renders for the active branch. */
export type ResolvedTranscript =
	| { readonly mode: "raw" }
	| { readonly mode: "projected"; readonly items: readonly ResolvedItem[] };

const DEFAULT_TIMEOUT_MS = 2000;

const SYSTEM_TIMERS: TranscriptProjectionTimers = {
	set: (callback, ms) => setTimeout(callback, ms),
	clear: (handle) => clearTimeout(handle),
};

/** The projection state of one revision. A revision without state is requested when resolved again. */
type RevisionState =
	| { readonly kind: "projected"; readonly revision: number; readonly items: readonly ResolvedItem[] }
	| { readonly kind: "declined"; readonly revision: number }
	| { readonly kind: "fallback"; readonly revision: number };

type AttemptOutcome =
	| { readonly kind: "resolved"; readonly projection: TranscriptProjection | undefined }
	| { readonly kind: "rejected"; readonly rejection: RejectedTranscriptProjection };

/** One `project()` call; a settlement of any earlier attempt is discarded. */
interface Attempt {
	readonly revision: number;
	readonly providerId: string;
	readonly entryIds: readonly string[];
	settled: boolean;
	timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Owns the projection state machine for one session: at most one `project()` in flight, one validated
 * projection cached per revision, one warning per (provider, reason), and host-owned reveal state.
 */
export class TranscriptProjectionController {
	private readonly source: TranscriptProjectionSource;
	private readonly warn: (message: string) => void;
	private readonly onRefresh: () => void;
	private readonly timeoutMs: number;
	private readonly timers: TranscriptProjectionTimers;
	private readonly unsubscribe: () => void;

	/** The current snapshot; its revision changes only when the ordered branch ids change. */
	private snapshot: TranscriptSnapshot | undefined;
	private state: RevisionState | undefined;
	private attempt: Attempt | undefined;
	/** A revision resolved while an attempt was in flight. */
	private queued = false;
	private readonly revealed = new Set<string>();
	private readonly warned = new Set<string>();
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;

	constructor(deps: TranscriptProjectionControllerDeps) {
		this.source = deps.source;
		this.warn = deps.warn;
		this.onRefresh = deps.onRefresh;
		this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.timers = deps.timers ?? SYSTEM_TIMERS;
		this.unsubscribe = deps.source.subscribe((event) => this.handleEvent(event));
	}

	/** What to render for `entries`: the projection of exactly this branch, or the ordinary transcript. */
	resolve(entries: readonly SessionEntry[]): ResolvedTranscript {
		if (this.disposed) return { mode: "raw" };
		const snapshot = this.track(entries);
		const provider = this.source.getProvider();
		if (provider === undefined) return { mode: "raw" };

		const state = this.state;
		if (state !== undefined && state.revision === snapshot.revision) {
			return state.kind === "projected" ? { mode: "projected", items: state.items } : { mode: "raw" };
		}
		if (this.attempt === undefined) {
			this.startAttempt(provider, snapshot);
		} else if (this.attempt.revision !== snapshot.revision) {
			this.queued = true;
		}
		return { mode: "raw" };
	}

	isRevealed(spanId: string): boolean {
		return this.revealed.has(spanId);
	}

	/** Set the reveal state of a span and report whether it changed. */
	setRevealed(spanId: string, revealed: boolean): boolean {
		if (this.revealed.has(spanId) === revealed) return false;
		if (revealed) this.revealed.add(spanId);
		else this.revealed.delete(spanId);
		return true;
	}

	/** Flip the reveal state of a span and report whether it changed. */
	toggleRevealed(spanId: string): boolean {
		return this.setRevealed(spanId, !this.revealed.has(spanId));
	}

	/** Reveal or collapse every span of the cached projection and report whether anything changed. */
	revealAll(revealed: boolean): boolean {
		if (!revealed) {
			const changed = this.revealed.size > 0;
			this.revealed.clear();
			return changed;
		}
		const state = this.state;
		if (state === undefined || state.kind !== "projected") return false;
		let changed = false;
		for (const item of state.items) {
			if (item.kind !== "span" || this.revealed.has(item.spanId)) continue;
			this.revealed.add(item.spanId);
			changed = true;
		}
		return changed;
	}

	/** Run a span action. The built-in reveal and collapse actions stay local; provider errors are reported. */
	dispatchAction(spanId: string, actionId: string): void {
		if (this.disposed) return;
		if (actionId === REVEAL_ORIGINALS_ACTION || actionId === COLLAPSE_ACTION) {
			if (this.setRevealed(spanId, actionId === REVEAL_ORIGINALS_ACTION)) this.onRefresh();
			return;
		}
		const provider = this.source.getProvider();
		if (provider === undefined) return;
		Promise.resolve()
			.then(() => provider.onAction(spanId, actionId))
			.catch((error: unknown) => {
				const detail = error instanceof Error ? error.message : String(error);
				this.warn(
					`transcript projection action "${actionId}" on span "${spanId}" from "${provider.id}" failed: ${detail}`,
				);
			});
	}

	/** Stop listening and discard every late result. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		this.dropAttempt();
		if (this.refreshTimer !== undefined) {
			this.timers.clear(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		this.queued = false;
		this.state = undefined;
		this.revealed.clear();
	}

	/** The snapshot of `entries`, reusing the previous one while the ordered ids are unchanged. */
	private track(entries: readonly SessionEntry[]): TranscriptSnapshot {
		const previous = this.snapshot;
		if (previous !== undefined && sameIds(previous.entries, entries)) return previous;

		const lastIndex = entries.length - 1;
		const snapshot: TranscriptSnapshot = {
			revision: previous === undefined ? 1 : previous.revision + 1,
			leafId: lastIndex < 0 ? "" : entries[lastIndex].id,
			entries: entries.map(toSnapshotEntry),
		};
		this.snapshot = snapshot;
		this.state = undefined;
		return snapshot;
	}

	private startAttempt(provider: TranscriptProjectionProvider, snapshot: TranscriptSnapshot): void {
		const attempt: Attempt = {
			revision: snapshot.revision,
			providerId: provider.id,
			entryIds: snapshot.entries.map((entry) => entry.id),
			settled: false,
			timer: undefined,
		};
		this.attempt = attempt;
		attempt.timer = this.timers.set(() => {
			const detail = `project() did not answer within ${this.timeoutMs} ms`;
			this.settle(attempt, { kind: "rejected", rejection: rejection(detail) });
		}, this.timeoutMs);
		Promise.resolve()
			.then(() => provider.project(snapshot))
			.then(
				(projection) => this.settle(attempt, { kind: "resolved", projection }),
				(error: unknown) => {
					const detail = error instanceof Error ? error.message : String(error);
					this.settle(attempt, { kind: "rejected", rejection: rejection(`project() threw: ${detail}`) });
				},
			);
	}

	private settle(attempt: Attempt, outcome: AttemptOutcome): void {
		if (attempt.settled) return;
		attempt.settled = true;
		if (attempt.timer !== undefined) this.timers.clear(attempt.timer);
		this.attempt = undefined;
		if (this.applyOutcome(attempt, outcome)) this.onRefresh();
		this.drainQueue();
	}

	/** Store the outcome for the current revision; reports whether the host must rebuild. */
	private applyOutcome(attempt: Attempt, outcome: AttemptOutcome): boolean {
		if (this.disposed) return false;
		if (attempt.revision !== this.snapshot?.revision) return false;
		const provider = this.source.getProvider();
		if (provider === undefined || provider.id !== attempt.providerId) return false;

		if (outcome.kind === "rejected") return this.enterFallback(attempt, outcome.rejection);
		if (outcome.projection === undefined) {
			this.state = { kind: "declined", revision: attempt.revision };
			return true;
		}
		const validation = validateTranscriptProjection(attempt.entryIds, outcome.projection);
		if (!validation.ok) return this.enterFallback(attempt, validation);
		this.state = { kind: "projected", revision: attempt.revision, items: validation.items };
		this.pruneReveal(validation.items);
		return true;
	}

	/** Enter the fallback state of this revision and warn once per distinct reason. */
	private enterFallback(attempt: Attempt, rejection: RejectedTranscriptProjection): true {
		this.state = { kind: "fallback", revision: attempt.revision };
		const key = `${attempt.providerId}\u0000${rejection.reason}`;
		if (this.warned.has(key)) return true;
		this.warned.add(key);
		this.warn(fallbackReason(attempt.providerId, rejection));
		return true;
	}

	/** Start the request of a revision that was resolved while an earlier attempt was in flight. */
	private drainQueue(): void {
		if (!this.queued) return;
		this.queued = false;
		if (this.disposed || this.attempt !== undefined) return;
		const snapshot = this.snapshot;
		if (snapshot === undefined) return;
		const state = this.state;
		if (state !== undefined && state.revision === snapshot.revision) return;
		const provider = this.source.getProvider();
		if (provider === undefined) return;
		this.startAttempt(provider, snapshot);
	}

	private handleEvent(event: TranscriptProjectionSourceEvent): void {
		if (this.disposed) return;
		this.state = undefined;
		this.dropAttempt();
		if (event.kind === "provider") {
			this.queued = false;
			this.revealed.clear();
			this.warned.clear();
			if (this.source.getProvider() === undefined) return;
		}
		this.refresh();
	}

	/** Coalesce provider events of one macrotask into one host rebuild. */
	private refresh(): void {
		if (this.refreshTimer !== undefined) return;
		this.refreshTimer = this.timers.set(() => {
			this.refreshTimer = undefined;
			if (this.disposed) return;
			this.onRefresh();
		}, 0);
	}

	/** Keep reveal state of spans that still exist; a reprojection owns its span ids afresh. */
	private pruneReveal(items: readonly ResolvedItem[]): void {
		const spanIds = new Set<string>();
		for (const item of items) {
			if (item.kind === "span") spanIds.add(item.spanId);
		}
		for (const spanId of this.revealed) {
			if (!spanIds.has(spanId)) this.revealed.delete(spanId);
		}
	}

	private dropAttempt(): void {
		const attempt = this.attempt;
		if (attempt === undefined) return;
		attempt.settled = true;
		if (attempt.timer !== undefined) this.timers.clear(attempt.timer);
		this.attempt = undefined;
	}
}

function sameIds(entries: readonly TranscriptSnapshotEntry[], next: readonly SessionEntry[]): boolean {
	if (entries.length !== next.length) return false;
	for (let index = 0; index < next.length; index++) {
		if (entries[index].id !== next[index].id) return false;
	}
	return true;
}

function toSnapshotEntry(entry: SessionEntry): TranscriptSnapshotEntry {
	if (entry.type === "message") {
		return {
			id: entry.id,
			parentId: entry.parentId,
			kind: entry.type,
			role: entry.message.role,
			timestamp: entry.timestamp,
		};
	}
	return { id: entry.id, parentId: entry.parentId, kind: entry.type, timestamp: entry.timestamp };
}

// The contract has no rejection reason for a provider that throws or does not answer, so both report
// the generic reason and carry the concrete cause in the detail line.
function rejection(detail: string): RejectedTranscriptProjection {
	return { ok: false, reason: "invalid-projection", detail };
}
