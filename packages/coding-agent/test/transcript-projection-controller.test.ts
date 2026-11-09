import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import type {
	SpanItem,
	TranscriptItem,
	TranscriptProjection,
	TranscriptProjectionProvider,
	TranscriptSnapshot,
} from "../src/core/transcript-projection.ts";
import {
	COLLAPSE_ACTION,
	REVEAL_ORIGINALS_ACTION,
	TranscriptProjectionController,
	type TranscriptProjectionControllerDeps,
	type TranscriptProjectionSource,
	type TranscriptProjectionSourceEvent,
} from "../src/modes/interactive/transcript-projection-controller.ts";

class FakeSource implements TranscriptProjectionSource {
	provider: TranscriptProjectionProvider | undefined;
	private readonly listeners = new Set<(event: TranscriptProjectionSourceEvent) => void>();

	getProvider(): TranscriptProjectionProvider | undefined {
		return this.provider;
	}

	subscribe(listener: (event: TranscriptProjectionSourceEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	emit(kind: "provider" | "invalidate"): void {
		for (const listener of [...this.listeners]) listener({ kind });
	}

	get subscriberCount(): number {
		return this.listeners.size;
	}
}

interface FakeProvider {
	provider: TranscriptProjectionProvider;
	snapshots: TranscriptSnapshot[];
	actions: { spanId: string; actionId: string }[];
}

function fakeProvider(
	project: TranscriptProjectionProvider["project"],
	onAction: TranscriptProjectionProvider["onAction"] = () => {},
): FakeProvider {
	const snapshots: TranscriptSnapshot[] = [];
	const actions: { spanId: string; actionId: string }[] = [];
	const provider: TranscriptProjectionProvider = {
		id: "fake",
		project: (snapshot) => {
			snapshots.push(snapshot);
			return project(snapshot);
		},
		onAction: (spanId, actionId) => {
			actions.push({ spanId, actionId });
			return onAction(spanId, actionId);
		},
	};
	return { provider, snapshots, actions };
}

interface Harness {
	controller: TranscriptProjectionController;
	source: FakeSource;
	warn: ReturnType<typeof vi.fn<(message: string) => void>>;
	onRefresh: ReturnType<typeof vi.fn<() => void>>;
}

function harness(overrides: Pick<TranscriptProjectionControllerDeps, "timeoutMs"> = {}): Harness {
	const source = new FakeSource();
	const warn = vi.fn<(message: string) => void>();
	const onRefresh = vi.fn<() => void>();
	const controller = new TranscriptProjectionController({ source, warn, onRefresh, ...overrides });
	return { controller, source, warn, onRefresh };
}

function branch(...ids: string[]): SessionEntry[] {
	return ids.map((id, index) => ({
		type: "thinking_level_change",
		id,
		parentId: index === 0 ? null : ids[index - 1],
		timestamp: `t${index}`,
		thinkingLevel: "medium",
	}));
}

function userEntry(id: string, parentId: string | null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "t-user",
		message: { role: "user", content: "hello", timestamp: 0 },
	};
}

function spanItem(spanId: string, entryIds: string[]): SpanItem {
	return {
		kind: "span",
		spanId,
		entryIds,
		rows: [{ segments: [{ text: spanId, tone: "text" }] }],
		actions: [],
		state: "accent",
		label: spanId,
	};
}

function projectionOf(revision: number, ...items: TranscriptItem[]): TranscriptProjection {
	return { revision, items };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("TranscriptProjectionController", () => {
	it("discards a stale result and projects the newer revision", async () => {
		vi.useFakeTimers();
		const { controller, source, onRefresh } = harness();
		const first = Promise.withResolvers<TranscriptProjection | undefined>();
		const second = Promise.withResolvers<TranscriptProjection | undefined>();
		const answers = [first.promise, second.promise];
		let calls = 0;
		const fake = fakeProvider(() => answers[calls++]);
		source.provider = fake.provider;

		const older = [userEntry("e1", null), ...branch("e2")];
		const newer = [...older, ...branch("e3")];
		expect(controller.resolve(older)).toEqual({ mode: "raw" });
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.snapshots).toHaveLength(1);
		expect(fake.snapshots[0]).toMatchObject({ revision: 1, leafId: "e2" });
		expect(fake.snapshots[0].entries[0]).toEqual({
			id: "e1",
			parentId: null,
			kind: "message",
			role: "user",
			timestamp: "t-user",
		});

		expect(controller.resolve(newer)).toEqual({ mode: "raw" });
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.snapshots).toHaveLength(1);

		first.resolve(projectionOf(1, spanItem("s1", ["e1", "e2"])));
		await vi.advanceTimersByTimeAsync(0);
		expect(onRefresh).not.toHaveBeenCalled();
		expect(fake.snapshots).toHaveLength(2);
		expect(fake.snapshots[1].revision).toBe(2);

		const final = projectionOf(2, spanItem("s2", ["e1", "e2", "e3"]));
		second.resolve(final);
		await vi.advanceTimersByTimeAsync(0);
		expect(onRefresh).toHaveBeenCalledTimes(1);
		expect(controller.resolve(newer)).toEqual({ mode: "projected", items: final.items });
	});

	it("warns once, falls back, and recovers after an invalidation", async () => {
		vi.useFakeTimers();
		const { controller, source, warn, onRefresh } = harness();
		let answer = projectionOf(1, spanItem("s1", ["e2"]));
		const fake = fakeProvider(() => answer);
		source.provider = fake.provider;

		expect(controller.resolve(branch("e1", "e2"))).toEqual({ mode: "raw" });
		await vi.advanceTimersByTimeAsync(0);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain('"fake"');
		expect(warn.mock.calls[0][0]).toContain("missing-entry");
		expect(onRefresh).toHaveBeenCalledTimes(1);

		expect(controller.resolve(branch("e1", "e2"))).toEqual({ mode: "raw" });
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.snapshots).toHaveLength(1);

		answer = projectionOf(1, spanItem("s1", ["e1", "e2"]));
		source.emit("invalidate");
		await vi.advanceTimersByTimeAsync(0);
		expect(onRefresh).toHaveBeenCalledTimes(2);

		expect(controller.resolve(branch("e1", "e2"))).toEqual({ mode: "raw" });
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.snapshots).toHaveLength(2);
		expect(controller.resolve(branch("e1", "e2"))).toEqual({ mode: "projected", items: answer.items });
	});

	it("falls back when a projection times out and ignores its late answer", async () => {
		vi.useFakeTimers();
		const { controller, source, warn, onRefresh } = harness({ timeoutMs: 2000 });
		const late = Promise.withResolvers<TranscriptProjection | undefined>();
		const fake = fakeProvider(() => late.promise);
		source.provider = fake.provider;

		controller.resolve(branch("e1"));
		await vi.advanceTimersByTimeAsync(1999);
		expect(warn).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain("did not answer within 2000 ms");
		expect(onRefresh).toHaveBeenCalledTimes(1);
		expect(controller.resolve(branch("e1"))).toEqual({ mode: "raw" });

		late.resolve(projectionOf(1, spanItem("s1", ["e1"])));
		await vi.advanceTimersByTimeAsync(0);
		expect(onRefresh).toHaveBeenCalledTimes(1);
		expect(controller.resolve(branch("e1"))).toEqual({ mode: "raw" });
	});

	it("keeps the ordinary transcript when the provider declines", async () => {
		vi.useFakeTimers();
		const { controller, source, warn, onRefresh } = harness();
		const fake = fakeProvider(() => undefined);
		source.provider = fake.provider;

		expect(controller.resolve(branch("e1"))).toEqual({ mode: "raw" });
		await vi.advanceTimersByTimeAsync(0);
		expect(warn).not.toHaveBeenCalled();
		expect(onRefresh).toHaveBeenCalledTimes(1);

		expect(controller.resolve(branch("e1"))).toEqual({ mode: "raw" });
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.snapshots).toHaveLength(1);
	});

	it("keeps reveal state across a reprojection and drops vanished spans", async () => {
		vi.useFakeTimers();
		const { controller, source } = harness();
		let answer = projectionOf(1, spanItem("s1", ["e1", "e2"]), spanItem("s2", ["e3"]));
		const fake = fakeProvider(() => answer);
		source.provider = fake.provider;

		controller.resolve(branch("e1", "e2", "e3"));
		await vi.advanceTimersByTimeAsync(0);

		expect(controller.revealAll(true)).toBe(true);
		expect(controller.revealAll(true)).toBe(false);
		expect(controller.isRevealed("s1")).toBe(true);
		expect(controller.isRevealed("s2")).toBe(true);
		expect(controller.setRevealed("s2", false)).toBe(true);
		expect(controller.setRevealed("s2", false)).toBe(false);
		expect(controller.toggleRevealed("s2")).toBe(true);
		expect(controller.isRevealed("s2")).toBe(true);

		answer = projectionOf(1, spanItem("s1", ["e1", "e2", "e3"]));
		source.emit("invalidate");
		await vi.advanceTimersByTimeAsync(0);
		controller.resolve(branch("e1", "e2", "e3"));
		await vi.advanceTimersByTimeAsync(0);

		expect(controller.isRevealed("s1")).toBe(true);
		expect(controller.isRevealed("s2")).toBe(false);
		expect(controller.revealAll(false)).toBe(true);
		expect(controller.isRevealed("s1")).toBe(false);
	});

	it("handles built-in actions locally and reports a thrown provider action", async () => {
		vi.useFakeTimers();
		const { controller, source, warn, onRefresh } = harness();
		const fake = fakeProvider(
			() => projectionOf(1, spanItem("s1", ["e1"])),
			() => {
				throw new Error("boom");
			},
		);
		source.provider = fake.provider;
		controller.resolve(branch("e1"));
		await vi.advanceTimersByTimeAsync(0);
		onRefresh.mockClear();

		controller.dispatchAction("s1", REVEAL_ORIGINALS_ACTION);
		expect(controller.isRevealed("s1")).toBe(true);
		expect(onRefresh).toHaveBeenCalledTimes(1);
		expect(fake.actions).toEqual([]);

		controller.dispatchAction("s1", COLLAPSE_ACTION);
		expect(controller.isRevealed("s1")).toBe(false);
		expect(onRefresh).toHaveBeenCalledTimes(2);
		expect(fake.actions).toEqual([]);

		expect(() => controller.dispatchAction("s1", "retry")).not.toThrow();
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.actions).toEqual([{ spanId: "s1", actionId: "retry" }]);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain("boom");
	});

	it("reports a rejected provider action without throwing", async () => {
		vi.useFakeTimers();
		const { controller, source, warn } = harness();
		const fake = fakeProvider(
			() => projectionOf(1, spanItem("s1", ["e1"])),
			() => Promise.reject(new Error("nope")),
		);
		source.provider = fake.provider;
		controller.resolve(branch("e1"));
		await vi.advanceTimersByTimeAsync(0);

		expect(() => controller.dispatchAction("s1", "retry")).not.toThrow();
		await vi.advanceTimersByTimeAsync(0);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain("nope");
	});

	it("drops a provider action for a span the active provider did not project", async () => {
		vi.useFakeTimers();
		const { controller, source } = harness();
		const first = fakeProvider(() => projectionOf(1, spanItem("s1", ["e1"])));
		source.provider = first.provider;
		controller.resolve(branch("e1"));
		await vi.advanceTimersByTimeAsync(0);

		// The replacement projects a different span, so the click on the old one has no owner.
		const second = fakeProvider(() => projectionOf(1, spanItem("s2", ["e1"])));
		source.provider = second.provider;
		source.emit("provider");
		controller.dispatchAction("s1", "retry");
		await vi.advanceTimersByTimeAsync(0);
		controller.resolve(branch("e1"));
		await vi.advanceTimersByTimeAsync(0);
		controller.dispatchAction("s1", "retry");
		await vi.advanceTimersByTimeAsync(0);

		expect(first.actions).toEqual([]);
		expect(second.actions).toEqual([]);

		// Its own span still runs.
		controller.dispatchAction("s2", "retry");
		await vi.advanceTimersByTimeAsync(0);
		expect(second.actions).toEqual([{ spanId: "s2", actionId: "retry" }]);
	});

	it("coalesces provider events into one refresh per macrotask", async () => {
		vi.useFakeTimers();
		const { controller, source, onRefresh } = harness();
		source.emit("invalidate");
		source.emit("invalidate");
		expect(onRefresh).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(0);
		expect(onRefresh).toHaveBeenCalledTimes(1);

		source.provider = fakeProvider(() => undefined).provider;
		source.emit("provider");
		source.emit("provider");
		await vi.advanceTimersByTimeAsync(0);
		expect(onRefresh).toHaveBeenCalledTimes(2);
		expect(controller.resolve(branch("e1"))).toEqual({ mode: "raw" });
	});

	it("returns the ordinary transcript without a provider", () => {
		const { controller, source } = harness();
		expect(controller.resolve(branch("e1"))).toEqual({ mode: "raw" });
		expect(source.subscriberCount).toBe(1);
	});

	it("ignores late results and unanswered projections after dispose", async () => {
		vi.useFakeTimers();
		const { controller, source, warn, onRefresh } = harness();
		const late = Promise.withResolvers<TranscriptProjection | undefined>();
		const fake = fakeProvider(() => late.promise);
		source.provider = fake.provider;

		controller.resolve(branch("e1"));
		await vi.advanceTimersByTimeAsync(0);
		controller.dispose();
		expect(source.subscriberCount).toBe(0);

		late.resolve(projectionOf(1, spanItem("s1", ["e1"])));
		await vi.advanceTimersByTimeAsync(2000);
		expect(onRefresh).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
		expect(controller.resolve(branch("e1"))).toEqual({ mode: "raw" });
	});
});
