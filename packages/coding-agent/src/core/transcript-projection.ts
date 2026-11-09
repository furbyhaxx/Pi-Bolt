/**
 * Contract for transcript projections: an extension presents spans of the active branch as compact
 * host-rendered records instead of the raw entries. The host owns layout, scrolling, focus, streaming
 * and expansion; the provider only says how the branch is presented.
 *
 * Everything here is plain data and pure validation, so another host can implement the same contract.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "./session-manager.ts";

/** Semantic style tokens the host resolves through its theme. Provider rows never carry ANSI. */
export const TRANSCRIPT_TONES = ["text", "muted", "dim", "accent", "success", "warning", "error"] as const;

/** A semantic style token. */
export type Tone = (typeof TRANSCRIPT_TONES)[number];

/** Bounds a projection must respect; an exceeded bound rejects the projection for the whole view. */
export const TRANSCRIPT_PROJECTION_LIMITS = {
	maxRowsPerSpan: 12,
	maxSegmentsPerRow: 8,
	maxTextLength: 240,
	maxActionsPerSpan: 6,
	maxRowIndent: 8,
} as const;

const { maxRowsPerSpan, maxSegmentsPerRow, maxTextLength, maxActionsPerSpan, maxRowIndent } =
	TRANSCRIPT_PROJECTION_LIMITS;

/**
 * One stretch of text inside a row; `text` is stripped of control characters during validation.
 *
 * `shrink` marks the segment a host narrows first: a row wider than the terminal takes width away from the
 * shrinkable segments before anything else, down to 3 visible columns, ellipsis included, while the other segments
 * keep their text. If the row still does not fit, the host truncates it from the right. A host that ignores the field
 * truncates from the right, which is allowed.
 */
export type Segment = {
	readonly text: string;
	readonly tone: Tone;
	readonly bold?: boolean;
	readonly shrink?: boolean;
};

/** One line of a span; `indent` is the extra left indentation levels, 0 to `TRANSCRIPT_PROJECTION_LIMITS.maxRowIndent`. */
export type Row = { readonly segments: readonly Segment[]; readonly indent?: number };

/** An action the provider offers on a span. The host adds its own reveal and collapse actions. */
export type Action = { readonly id: string; readonly label: string; readonly key?: string };

/** Renders its branch entry as the ordinary transcript does. */
export type EntryItem = { readonly kind: "entry"; readonly entryId: string };

/** Replaces its branch entries with provider rows. */
export type SpanItem = {
	readonly kind: "span";
	readonly spanId: string;
	/** Branch entries the span covers, contiguous and in branch order. */
	readonly entryIds: readonly string[];
	readonly rows: readonly Row[];
	readonly actions: readonly Action[];
	readonly state: Tone;
	readonly label: string;
};

/** One position of a projection. */
export type TranscriptItem = EntryItem | SpanItem;

/** A validated item: same shape, display text already stripped of control characters. */
export type ResolvedItem = TranscriptItem;

/** What a provider returns for one snapshot revision; results for a replaced revision are discarded. */
export type TranscriptProjection = { readonly revision: number; readonly items: readonly TranscriptItem[] };

/** One entry of the active branch, without its body. */
export type TranscriptSnapshotEntry = {
	readonly id: string;
	readonly parentId: string | null;
	readonly kind: SessionEntry["type"];
	/** Message role, set for `kind: "message"` entries. */
	readonly role?: AgentMessage["role"];
	readonly timestamp: string;
};

/** The active branch a provider projects. */
export type TranscriptSnapshot = {
	readonly revision: number;
	readonly leafId: string;
	readonly entries: readonly TranscriptSnapshotEntry[];
};

/**
 * Registered by an extension. `project` may return undefined to keep the ordinary transcript, and may
 * throw or time out: the host then falls back and reports the failure.
 */ export interface TranscriptProjectionProvider {
	readonly id: string;
	project(snapshot: TranscriptSnapshot): TranscriptProjection | undefined | Promise<TranscriptProjection | undefined>;
	/** Called when the user triggers a provider action of a rendered span. */
	onAction(spanId: string, actionId: string): void | Promise<void>;
}

/**
 * Returned by `pi.registerTranscriptProjection()`. `invalidate()` asks the host to call `project()` again for the
 * current branch; it is cheap and idempotent, and a no-op after the provider went away.
 */
export interface TranscriptProjectionHandle {
	invalidate(): void;
}

/** What changed: a provider was registered, replaced or removed, or the active provider asked for a refresh. */
export type TranscriptProjectionChange = { readonly kind: "provider" | "invalidate" };

/** Why the host rejected a projection and renders the ordinary transcript instead. */
export type ProjectionRejectionReason =
	| "invalid-projection"
	| "invalid-item"
	| "unknown-entry"
	| "duplicate-entry"
	| "missing-entry"
	| "item-out-of-order"
	| "empty-span"
	| "empty-span-id"
	| "duplicate-span-id"
	| "span-out-of-order"
	| "span-not-contiguous"
	| "unknown-tone"
	| "too-many-rows"
	| "too-many-segments"
	| "text-too-long"
	| "too-many-actions"
	| "indent-out-of-range";

/** The projection passed validation and is safe to render, raw streaming-tail items included. */
export type ValidTranscriptProjection = { readonly ok: true; readonly items: readonly ResolvedItem[] };

/** The host must render the ordinary transcript for the whole view and warn about the provider. */
export type RejectedTranscriptProjection = {
	readonly ok: false;
	readonly reason: ProjectionRejectionReason;
	/** One line of concrete detail for the host warning. */
	readonly detail: string;
};

/** Result of `validateTranscriptProjection`. */
export type TranscriptProjectionValidation = ValidTranscriptProjection | RejectedTranscriptProjection;

/** One-line host warning naming the provider and why its projection was rejected. */
export function fallbackReason(providerId: string, rejection: RejectedTranscriptProjection): string {
	const provider = stripControlCharacters(providerId);
	return `transcript projection from "${provider}" rejected (${rejection.reason}): ${rejection.detail}`;
}

/** Checks a projection against the active branch; entries after the coverage come back as raw items. */
export function validateTranscriptProjection(
	snapshotEntryIds: readonly string[],
	projection: TranscriptProjection,
): TranscriptProjectionValidation {
	if (!isRecord(projection) || !Array.isArray(projection.items)) {
		return reject("invalid-projection", "projection has no items array");
	}
	if (!Number.isFinite(projection.revision)) {
		return reject("invalid-projection", "projection.revision is not a finite number");
	}

	const branchPosition = new Map<string, number>();
	for (const [index, entryId] of snapshotEntryIds.entries()) {
		branchPosition.set(entryId, index);
	}
	const coveredBy = new Map<string, string>();
	const spanIds = new Set<string>();
	const sequence: { position: number; label: string }[] = [];
	const items: ResolvedItem[] = [];

	for (const rawItem of projection.items as readonly unknown[]) {
		if (!isRecord(rawItem)) {
			return reject("invalid-item", "an item is not an object");
		}
		if (rawItem.kind === "entry") {
			const entryId = rawItem.entryId;
			if (typeof entryId !== "string" || entryId.length === 0) {
				return reject("invalid-item", "an entry item has no entryId");
			}
			const position = branchPosition.get(entryId);
			if (position === undefined) {
				return reject("unknown-entry", `the branch has no entry ${quoted(entryId)}`);
			}
			const duplicate = claimEntry(coveredBy, entryId, "an entry item");
			if (duplicate !== undefined) {
				return duplicate;
			}
			sequence.push({ position, label: `entry ${quoted(entryId)}` });
			items.push({ kind: "entry", entryId });
			continue;
		}
		if (rawItem.kind !== "span") {
			return reject("invalid-item", `an item has the unknown kind ${describeValue(rawItem.kind)}`);
		}

		const spanId = rawItem.spanId;
		if (typeof spanId !== "string" || spanId.trim().length === 0) {
			return reject("empty-span-id", "a span has no spanId");
		}
		if (spanIds.has(spanId)) {
			return reject("duplicate-span-id", `span ${quoted(spanId)} appears more than once`);
		}
		spanIds.add(spanId);

		const entryIds = rawItem.entryIds;
		if (!Array.isArray(entryIds)) {
			return reject("invalid-item", `span ${quoted(spanId)} has no entryIds array`);
		}
		if (entryIds.length === 0) {
			return reject("empty-span", `span ${quoted(spanId)} covers no entries`);
		}
		const state = rawItem.state;
		if (!isTone(state)) {
			return reject("unknown-tone", `span ${quoted(spanId)} has the state ${describeValue(state)}`);
		}
		const rawLabel = rawItem.label;
		if (typeof rawLabel !== "string") {
			return reject("invalid-item", `span ${quoted(spanId)} has no label`);
		}
		const label = stripControlCharacters(rawLabel);
		if (label.trim().length === 0) {
			return reject("invalid-item", `span ${quoted(spanId)} has an empty label`);
		}
		if (label.length > maxTextLength) {
			return reject("text-too-long", `the label of span ${quoted(spanId)} is longer than ${maxTextLength}`);
		}

		const rawRows = rawItem.rows;
		if (!Array.isArray(rawRows)) {
			return reject("invalid-item", `span ${quoted(spanId)} has no rows array`);
		}
		if (rawRows.length > maxRowsPerSpan) {
			return reject("too-many-rows", `span ${quoted(spanId)} has ${rawRows.length} rows, limit ${maxRowsPerSpan}`);
		}
		const rows: Row[] = [];
		for (const rawRow of rawRows as readonly unknown[]) {
			const parsed = readRow(rawRow, spanId);
			if ("rejection" in parsed) {
				return parsed.rejection;
			}
			rows.push(parsed.parsed);
		}

		const rawActions = rawItem.actions;
		if (!Array.isArray(rawActions)) {
			return reject("invalid-item", `span ${quoted(spanId)} has no actions array`);
		}
		if (rawActions.length > maxActionsPerSpan) {
			return reject(
				"too-many-actions",
				`span ${quoted(spanId)} has ${rawActions.length} actions, limit ${maxActionsPerSpan}`,
			);
		}
		const actions: Action[] = [];
		for (const rawAction of rawActions as readonly unknown[]) {
			const parsed = readAction(rawAction, spanId);
			if ("rejection" in parsed) {
				return parsed.rejection;
			}
			actions.push(parsed.parsed);
		}

		const resolvedEntryIds: string[] = [];
		let previous = -1;
		for (const entryId of entryIds as readonly unknown[]) {
			if (typeof entryId !== "string") {
				return reject("invalid-item", `span ${quoted(spanId)} has an entryId that is not a string`);
			}
			const position = branchPosition.get(entryId);
			if (position === undefined) {
				return reject("unknown-entry", `span ${quoted(spanId)} covers the unknown entry ${quoted(entryId)}`);
			}
			const duplicate = claimEntry(coveredBy, entryId, `span ${quoted(spanId)}`);
			if (duplicate !== undefined) {
				return duplicate;
			}
			if (previous >= 0) {
				const lastEntryId = quoted(resolvedEntryIds[resolvedEntryIds.length - 1]);
				if (position <= previous) {
					return reject("span-out-of-order", `${quoted(entryId)} precedes ${lastEntryId} in ${quoted(spanId)}`);
				}
				if (position !== previous + 1) {
					return reject("span-not-contiguous", `span ${quoted(spanId)} skips entries after ${lastEntryId}`);
				}
			}
			previous = position;
			resolvedEntryIds.push(entryId);
			sequence.push({ position, label: `span ${quoted(spanId)}` });
		}

		items.push({ kind: "span", spanId, entryIds: resolvedEntryIds, rows, actions, state, label });
	}

	// Order before coverage: a reordered projection must not be reported as missing an entry it covers.
	let highest = -1;
	for (const step of sequence) {
		if (step.position <= highest) {
			return reject("item-out-of-order", `${step.label} covers branch entries that come earlier than it`);
		}
		highest = step.position;
	}
	for (const [index, step] of sequence.entries()) {
		if (step.position !== index) {
			return reject("missing-entry", `branch entry ${quoted(snapshotEntryIds[index])} is not covered`);
		}
	}

	for (let index = sequence.length; index < snapshotEntryIds.length; index++) {
		items.push({ kind: "entry", entryId: snapshotEntryIds[index] });
	}
	return { ok: true, items };
}

type Parsed<T> = { readonly parsed: T } | { readonly rejection: RejectedTranscriptProjection };

function claimEntry(
	coveredBy: Map<string, string>,
	entryId: string,
	cover: string,
): RejectedTranscriptProjection | undefined {
	const previousCover = coveredBy.get(entryId);
	if (previousCover === undefined) {
		coveredBy.set(entryId, cover);
		return undefined;
	}
	return reject("duplicate-entry", `entry ${quoted(entryId)} is already covered by ${previousCover}`);
}

function readRow(raw: unknown, spanId: string): Parsed<Row> {
	if (!isRecord(raw)) {
		return { rejection: reject("invalid-item", `span ${quoted(spanId)} has a row that is not an object`) };
	}
	const rawSegments = raw.segments;
	if (!Array.isArray(rawSegments)) {
		return { rejection: reject("invalid-item", `a row of span ${quoted(spanId)} has no segments array`) };
	}
	if (rawSegments.length > maxSegmentsPerRow) {
		return { rejection: reject("too-many-segments", `a row of span ${quoted(spanId)} has too many segments`) };
	}
	const segments: Segment[] = [];
	for (const rawSegment of rawSegments as readonly unknown[]) {
		if (!isRecord(rawSegment)) {
			return { rejection: reject("invalid-item", `a segment of span ${quoted(spanId)} is not an object`) };
		}
		if (typeof rawSegment.text !== "string") {
			return { rejection: reject("invalid-item", `a segment of span ${quoted(spanId)} has no text`) };
		}
		const text = stripControlCharacters(rawSegment.text);
		if (text.length > maxTextLength) {
			return {
				rejection: reject("text-too-long", `a segment of span ${quoted(spanId)} is longer than ${maxTextLength}`),
			};
		}
		const tone = rawSegment.tone;
		if (!isTone(tone)) {
			return { rejection: reject("unknown-tone", `a segment of span ${quoted(spanId)} has an unknown tone`) };
		}
		const bold = rawSegment.bold;
		if (bold !== undefined && typeof bold !== "boolean") {
			return { rejection: reject("invalid-item", `a segment of span ${quoted(spanId)} has a non-boolean bold`) };
		}
		const shrink = rawSegment.shrink;
		if (shrink !== undefined && typeof shrink !== "boolean") {
			return { rejection: reject("invalid-item", `a segment of span ${quoted(spanId)} has a non-boolean shrink`) };
		}
		segments.push({ text, tone, bold, shrink });
	}
	const indent = raw.indent;
	if (
		indent !== undefined &&
		(typeof indent !== "number" || !Number.isInteger(indent) || indent < 0 || indent > maxRowIndent)
	) {
		return {
			rejection: reject(
				"indent-out-of-range",
				`a row of span ${quoted(spanId)} has indent ${describeValue(indent)}`,
			),
		};
	}
	return { parsed: { segments, indent } };
}

function readAction(raw: unknown, spanId: string): Parsed<Action> {
	if (!isRecord(raw)) {
		return { rejection: reject("invalid-item", `span ${quoted(spanId)} has an action that is not an object`) };
	}
	const id = raw.id;
	if (typeof id !== "string" || id.trim().length === 0) {
		return { rejection: reject("invalid-item", `an action of span ${quoted(spanId)} has no id`) };
	}
	if (typeof raw.label !== "string") {
		return { rejection: reject("invalid-item", `action ${quoted(id)} of span ${quoted(spanId)} has no label`) };
	}
	const label = stripControlCharacters(raw.label);
	if (label.trim().length === 0) {
		return { rejection: reject("invalid-item", `action ${quoted(id)} of span ${quoted(spanId)} has an empty label`) };
	}
	if (label.length > maxTextLength) {
		return {
			rejection: reject("text-too-long", `the label of action ${quoted(id)} is longer than ${maxTextLength}`),
		};
	}
	const key = raw.key;
	if (key !== undefined && typeof key !== "string") {
		return {
			rejection: reject("invalid-item", `action ${quoted(id)} of span ${quoted(spanId)} has a non-string key`),
		};
	}
	return { parsed: { id, label, key: key === undefined ? undefined : stripControlCharacters(key) } };
}

/** Stripped, not rejected: provider text is display-only, and one stray escape must not fall back the view. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

function stripControlCharacters(text: string): string {
	return text.replace(CONTROL_CHARACTERS, "");
}

function quoted(text: string): string {
	return `"${stripControlCharacters(text)}"`;
}

function describeValue(value: unknown): string {
	return typeof value === "string" ? quoted(value) : `a non-string value (${typeof value})`;
}

function isTone(value: unknown): value is Tone {
	return typeof value === "string" && TRANSCRIPT_TONES.some((tone) => tone === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function reject(reason: ProjectionRejectionReason, detail: string): RejectedTranscriptProjection {
	return { ok: false, reason, detail };
}
