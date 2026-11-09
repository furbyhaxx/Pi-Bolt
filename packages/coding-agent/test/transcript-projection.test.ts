import { describe, expect, it } from "vitest";
import {
	fallbackReason,
	type ProjectionRejectionReason,
	type RejectedTranscriptProjection,
	type Row,
	type SpanItem,
	type Tone,
	TRANSCRIPT_PROJECTION_LIMITS,
	TRANSCRIPT_TONES,
	type TranscriptItem,
	type TranscriptProjection,
	validateTranscriptProjection,
} from "../src/core/transcript-projection.ts";

const branch = ["e1", "e2", "e3", "e4", "e5"];

function projection(...items: TranscriptItem[]): TranscriptProjection {
	return { revision: 1, items };
}

function entryItem(entryId: string): TranscriptItem {
	return { kind: "entry", entryId };
}

function spanItem(spanId: string, entryIds: string[], overrides: Partial<SpanItem> = {}): SpanItem {
	return {
		kind: "span",
		spanId,
		entryIds,
		rows: [{ segments: [{ text: "row", tone: "text" }] }],
		actions: [{ id: "open", label: "Open" }],
		state: "accent",
		label: "Span",
		...overrides,
	};
}

function row(segmentCount = 1): Row {
	return { segments: Array.from({ length: segmentCount }, () => ({ text: "row", tone: "text" })) };
}

function labelOf(item: TranscriptItem): string {
	return item.kind === "entry" ? item.entryId : item.spanId;
}

function accepted(items: TranscriptItem[], entryIds: readonly string[] = branch) {
	const result = validateTranscriptProjection(entryIds, projection(...items));
	if (!result.ok) {
		throw new Error(`expected acceptance, got ${result.reason}: ${result.detail}`);
	}
	return result.items;
}

function rejected(items: TranscriptItem[], entryIds: readonly string[] = branch): RejectedTranscriptProjection {
	const result = validateTranscriptProjection(entryIds, projection(...items));
	if (result.ok) {
		throw new Error(`expected rejection, got ${result.items.map(labelOf).join(", ")}`);
	}
	return result;
}

describe("validateTranscriptProjection acceptance", () => {
	it("keeps provider items and appends entries newer than the coverage", () => {
		const items = accepted([
			entryItem("e1"),
			spanItem("s1", ["e2", "e3"], {
				rows: [{ segments: [{ text: "2 tasks", tone: "success", bold: true }], indent: 1 }],
			}),
			entryItem("e4"),
		]);
		expect(items.map(labelOf)).toEqual(["e1", "s1", "e4", "e5"]);
		expect(items[1]).toEqual({
			kind: "span",
			spanId: "s1",
			entryIds: ["e2", "e3"],
			rows: [{ segments: [{ text: "2 tasks", tone: "success", bold: true }], indent: 1 }],
			actions: [{ id: "open", label: "Open" }],
			state: "accent",
			label: "Span",
		});
	});

	it("accepts a projection that covers the whole branch", () => {
		expect(accepted([entryItem("e1"), spanItem("s1", ["e2", "e3", "e4", "e5"])]).map(labelOf)).toEqual(["e1", "s1"]);
	});

	it("accepts an empty projection as the raw branch", () => {
		expect(accepted([]).map(labelOf)).toEqual(branch);
	});

	it("accepts every tone on span states and segments", () => {
		for (const tone of TRANSCRIPT_TONES) {
			const items = accepted([spanItem("s1", branch, { state: tone, rows: [{ segments: [{ text: "x", tone }] }] })]);
			expect(items[0]).toMatchObject({ kind: "span", state: tone });
		}
	});
	it("accepts a shrinkable segment and keeps the flag", () => {
		const items = accepted([
			spanItem("s1", branch, {
				rows: [{ segments: [{ text: "title", tone: "text", shrink: true }] }],
			}),
		]);
		expect(items[0]).toMatchObject({ rows: [{ segments: [{ text: "title", tone: "text", shrink: true }] }] });
	});
});

describe("validateTranscriptProjection rejection", () => {
	const rejections: { name: string; items: TranscriptItem[]; reason: ProjectionRejectionReason }[] = [
		{
			name: "an entry covered by an item and a span",
			items: [entryItem("e2"), spanItem("s1", ["e1", "e2"])],
			reason: "duplicate-entry",
		},
		{
			name: "an entry covered by two spans",
			items: [spanItem("s1", ["e1"]), spanItem("s2", ["e1"])],
			reason: "duplicate-entry",
		},
		{
			name: "a gap in the middle of the branch",
			items: [entryItem("e1"), entryItem("e3"), entryItem("e4"), entryItem("e5")],
			reason: "missing-entry",
		},
		{
			name: "span entryIds in the wrong branch order",
			items: [entryItem("e1"), spanItem("s1", ["e3", "e2"])],
			reason: "span-out-of-order",
		},
		{
			name: "a span that skips a branch entry",
			items: [entryItem("e1"), spanItem("s1", ["e2", "e4"])],
			reason: "span-not-contiguous",
		},
		{
			name: "an entry item with an unknown id",
			items: [entryItem("e9")],
			reason: "unknown-entry",
		},
		{
			name: "a span with an unknown id",
			items: [entryItem("e1"), spanItem("s1", ["e2", "e9"])],
			reason: "unknown-entry",
		},
		{
			name: "items in the wrong branch order",
			items: [entryItem("e2"), entryItem("e1")],
			reason: "item-out-of-order",
		},
		{
			name: "an empty span",
			items: [entryItem("e1"), spanItem("s1", [])],
			reason: "empty-span",
		},
		{
			name: "a blank spanId",
			items: [spanItem("   ", ["e1"])],
			reason: "empty-span-id",
		},
		{
			name: "a duplicate spanId",
			items: [spanItem("s1", ["e1"]), spanItem("s1", ["e2"])],
			reason: "duplicate-span-id",
		},
		{
			name: "an unknown span state",
			items: [spanItem("s1", ["e1"], { state: "purple" as Tone })],
			reason: "unknown-tone",
		},
		{
			name: "an unknown segment tone",
			items: [spanItem("s1", ["e1"], { rows: [{ segments: [{ text: "x", tone: "purple" as Tone }] }] })],
			reason: "unknown-tone",
		},
		{
			name: "a non-boolean shrink",
			items: [
				spanItem("s1", ["e1"], {
					rows: [{ segments: [{ text: "x", tone: "text", shrink: "yes" as unknown as boolean }] }],
				}),
			],
			reason: "invalid-item",
		},
		{
			name: "too many rows",
			items: [
				spanItem("s1", ["e1"], {
					rows: Array.from({ length: TRANSCRIPT_PROJECTION_LIMITS.maxRowsPerSpan + 1 }, () => row()),
				}),
			],
			reason: "too-many-rows",
		},
		{
			name: "too many segments in a row",
			items: [spanItem("s1", ["e1"], { rows: [row(TRANSCRIPT_PROJECTION_LIMITS.maxSegmentsPerRow + 1)] })],
			reason: "too-many-segments",
		},
		{
			name: "segment text over the limit",
			items: [
				spanItem("s1", ["e1"], {
					rows: [
						{ segments: [{ text: "x".repeat(TRANSCRIPT_PROJECTION_LIMITS.maxTextLength + 1), tone: "text" }] },
					],
				}),
			],
			reason: "text-too-long",
		},
		{
			name: "too many actions",
			items: [
				spanItem("s1", ["e1"], {
					actions: Array.from({ length: TRANSCRIPT_PROJECTION_LIMITS.maxActionsPerSpan + 1 }, (_, index) => ({
						id: `action-${index}`,
						label: "Action",
					})),
				}),
			],
			reason: "too-many-actions",
		},
		{
			name: "an indent over the limit",
			items: [
				spanItem("s1", ["e1"], {
					rows: [
						{
							segments: [{ text: "x", tone: "text" }],
							indent: TRANSCRIPT_PROJECTION_LIMITS.maxRowIndent + 1,
						},
					],
				}),
			],
			reason: "indent-out-of-range",
		},
	];

	it.each(rejections)("rejects $name", ({ items, reason }) => {
		expect(rejected(items).reason).toBe(reason);
	});

	it("rejects an entry left uncovered between covered entries", () => {
		const result = rejected([spanItem("s1", ["e1", "e2"]), spanItem("s2", ["e4", "e5"])]);
		expect(result).toMatchObject({ reason: "missing-entry" });
		expect(result.detail).toContain('"e3"');
	});
});

describe("control characters", () => {
	it("strips them from segment text, labels and action labels", () => {
		const items = accepted([
			spanItem("s1", branch, {
				label: "la\u0007bel",
				rows: [{ segments: [{ text: "a\u001b[31mb\nc", tone: "text" }] }],
				actions: [{ id: "open", label: "op\u0000en", key: "o\u0007" }],
			}),
		]);
		const span = items[0];
		if (span.kind !== "span") {
			throw new Error("expected a span item");
		}
		expect(span.label).toBe("label");
		expect(span.rows[0].segments[0].text).toBe("a[31mbc");
		expect(span.actions[0]).toEqual({ id: "open", label: "open", key: "o" });
	});

	it("keeps the fallback message on one line", () => {
		const rejection = rejected([entryItem("missing\u001b")]);
		const message = fallbackReason("taskfold\nprovider", rejection);
		expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
		expect(message).toContain('"taskfoldprovider"');
		expect(message).toContain("(unknown-entry)");
		expect(message).toContain('"missing"');
	});
});
