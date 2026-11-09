import { type Component, setKeybindings, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SpanItem } from "../src/core/transcript-projection.ts";
import { TranscriptSpanComponent } from "../src/modes/interactive/components/transcript-span.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const WIDTHS = [36, 57, 80, 140];

function spanItem(overrides: Partial<SpanItem> = {}): SpanItem {
	return {
		kind: "span",
		spanId: "span-1",
		entryIds: ["e1", "e2"],
		rows: [
			{
				segments: [
					{ text: "bash ", tone: "accent", bold: true },
					{ text: "npm test", tone: "text" },
					{ text: " · 42 passed", tone: "muted" },
				],
			},
			{
				segments: [
					{ text: "edit ", tone: "accent", bold: true },
					{ text: "src/a.ts", tone: "text" },
				],
				indent: 1,
			},
		],
		actions: [{ id: "inspect", label: "inspect record", key: "i" }],
		state: "success",
		label: "Audit tests",
		...overrides,
	};
}

function originalComponent(text: string): Component {
	return { render: () => [text], invalidate: () => {} };
}

function text(component: Component, width: number): string {
	return stripAnsi(component.render(width).join("\n"));
}

function expectLinesFit(component: Component, width: number): void {
	for (const [index, line] of component.render(width).entries()) {
		const visible = visibleWidth(line);
		expect(visible, `line ${index} is ${visible} columns at width ${width}: ${stripAnsi(line)}`).toBeLessThanOrEqual(
			width,
		);
	}
}

/** Two provider actions without keys, so a label's column is the label's own text. */
const TWO_ACTIONS: Partial<SpanItem> = {
	actions: [
		{ id: "inspect", label: "Inspect record" },
		{ id: "open", label: "Open in context" },
	],
};

/** The rendered hint line of a span, trimmed, and the row a click there reaches. */
function hintLine(component: Component, width: number): { text: string; y: number } {
	const lines = component.render(width).map(stripAnsi);
	// The hint is the line with the host's own expand hint; a revealed span puts entries beneath it.
	const y = lines.findIndex((line) => line.includes("reveal originals") || line.includes("collapse"));
	expect(y, `no hint line at width ${width}: ${lines.join("/")}`).toBeGreaterThanOrEqual(0);
	return { text: lines[y]!.trimEnd(), y };
}

function click(component: Component, x: number, y: number, width: number): void {
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		x,
		y,
		screenX: 0,
		screenY: 0,
		width,
		height: component.render(width).length,
		shift: false,
		alt: false,
		ctrl: false,
	};
	component.handleMouse?.(event);
}

describe("TranscriptSpanComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		// A user override proves the hints read the host's keybindings, not a hardcoded key.
		setKeybindings(new KeybindingsManager({ "app.tools.expand": "ctrl+e" }));
	});

	test("fits its width and keeps the disclosure, state word and label", () => {
		const component = new TranscriptSpanComponent(spanItem(), { renderOriginals: () => [] });

		for (const width of WIDTHS) {
			expectLinesFit(component, width);
			const rendered = text(component, width);
			expect(rendered).toContain("Audit tests");
			expect(rendered).toContain("done");
			expect(stripAnsi(component.render(width)[0]!)).toContain("▸");
			expect(rendered).toContain("npm test");
			expect(rendered).toContain("ctrl+e reveal originals");
			if (width >= 57) expect(rendered).toContain("inspect record");
		}
	});

	test("renders the original entries once, beneath a separator", () => {
		let calls = 0;
		const component = new TranscriptSpanComponent(spanItem(), {
			renderOriginals: () => {
				calls++;
				return [originalComponent("original user prompt")];
			},
		});
		expect(component.spanId).toBe("span-1");

		expect(text(component, 80)).not.toContain("original user prompt");
		component.render(80);
		expect(calls).toBe(0);

		component.setRevealed(true);
		const revealed = text(component, 80);
		expect(calls).toBe(1);
		expect(revealed).toContain("original user prompt");
		expect(revealed).toContain("original entries (2)");
		expect(revealed).toContain("ctrl+e collapse");
		expect(revealed.indexOf("original entries")).toBeLessThan(revealed.indexOf("original user prompt"));
		expect(stripAnsi(component.render(80)[0]!)).toContain("▾");

		component.setRevealed(false);
		expect(text(component, 80)).not.toContain("original user prompt");
		expect(calls).toBe(1);
	});

	test("truncates a long label and segment list without losing the state word", () => {
		const component = new TranscriptSpanComponent(
			spanItem({
				label: `Audit ${"label ".repeat(30)}`,
				rows: [
					{
						segments: [
							{ text: "bash ", tone: "accent", bold: true },
							{ text: "x".repeat(120), tone: "text" },
							{ text: " · trailing segment", tone: "muted" },
						],
					},
				],
			}),
			{ renderOriginals: () => [] },
		);

		expectLinesFit(component, 36);
		const [headline, row] = component.render(36).map((line) => stripAnsi(line).trimEnd());
		expect(headline).toContain("done");
		expect(headline).toContain("▸");
		expect(headline!.endsWith("...")).toBe(true);
		expect(row).toContain("bash");
		expect(row!.endsWith("...")).toBe(true);
		expect(component.render(36).length).toBe(3);
	});

	test("keeps the full handle by narrowing the shrinkable segment first", () => {
		const title = ` ${`a long task title `.repeat(4)}`;
		const component = new TranscriptSpanComponent(
			spanItem({
				rows: [
					{
						segments: [
							{ text: "done", tone: "success" },
							{ text: " ≡", tone: "dim" },
							{ text: title, tone: "text", bold: true, shrink: true },
							{ text: " t:final-survey/1", tone: "muted" },
						],
					},
				],
			}),
			{ renderOriginals: () => [] },
		);

		expectLinesFit(component, 36);
		const row = stripAnsi(component.render(36)[1]!).trimEnd();
		expect(row).toContain("done");
		expect(row).toContain("...");
		expect(row.endsWith("t:final-survey/1")).toBe(true);

		const roomy = stripAnsi(component.render(140)[1]!).trimEnd();
		expect(roomy).toContain(title.trimEnd());
		expect(roomy).not.toContain("...");
		expect(roomy.endsWith("t:final-survey/1")).toBe(true);
	});

	test("truncates from the right when no segment is shrinkable", () => {
		const component = new TranscriptSpanComponent(
			spanItem({
				rows: [
					{
						segments: [
							{ text: "done", tone: "success" },
							{ text: " ≡", tone: "dim" },
							{ text: ` ${`a long task title `.repeat(4)}`, tone: "text", bold: true },
							{ text: " t:final-survey/1", tone: "muted" },
						],
					},
				],
			}),
			{ renderOriginals: () => [] },
		);

		expectLinesFit(component, 36);
		const row = stripAnsi(component.render(36)[1]!).trimEnd();
		expect(row).toContain("done");
		expect(row.endsWith("...")).toBe(true);
		expect(row).not.toContain("t:final-survey/1");
	});

	test("folds rows past the collapsed limit until revealed", () => {
		const rows = [1, 2, 3, 4].map((index) => ({ segments: [{ text: `row ${index}`, tone: "text" as const }] }));
		const component = new TranscriptSpanComponent(spanItem({ rows }), {
			renderOriginals: () => [],
			collapsedRowsLimit: 2,
		});

		const collapsed = text(component, 80);
		expect(collapsed).toContain("row 1");
		expect(collapsed).toContain("row 2");
		expect(collapsed).not.toContain("row 3");
		expect(collapsed).toContain("... 2 more rows");

		component.setRevealed(true);
		const revealed = text(component, 80);
		expect(revealed).toContain("row 4");
		expect(revealed).not.toContain("more rows");
	});

	test("runs the clicked action label without toggling the span", () => {
		for (const width of [140, 80]) {
			const onAction = vi.fn<(actionId: string) => void>();
			const onToggleRevealed = vi.fn<(revealed: boolean) => void>();
			const component = new TranscriptSpanComponent(spanItem(TWO_ACTIONS), {
				renderOriginals: () => [originalComponent("original user prompt")],
				onAction,
				onToggleRevealed,
			});
			const hint = hintLine(component, width);
			expect(hint.text).toContain("Inspect record");
			expect(hint.text).toContain("Open in context");

			click(component, hint.text.indexOf("Open in context"), hint.y, width);
			expect(onAction.mock.calls).toEqual([["open"]]);

			click(component, hint.text.indexOf("Inspect record"), hint.y, width);
			expect(onAction.mock.calls).toEqual([["open"], ["inspect"]]);

			expect(onToggleRevealed).not.toHaveBeenCalled();
			expect(text(component, width)).not.toContain("original user prompt");
		}
	});

	test("toggles the span from a row or from the host's own hint label, running no action", () => {
		const onAction = vi.fn<(actionId: string) => void>();
		const onToggleRevealed = vi.fn<(revealed: boolean) => void>();
		const component = new TranscriptSpanComponent(spanItem(TWO_ACTIONS), {
			renderOriginals: () => [],
			onAction,
			onToggleRevealed,
		});

		click(component, 2, 1, 80);
		expect(onToggleRevealed.mock.calls).toEqual([[true]]);

		const hint = hintLine(component, 80);
		expect(hint.text).toContain("collapse");
		click(component, hint.text.indexOf("collapse"), hint.y, 80);
		expect(onToggleRevealed.mock.calls).toEqual([[true], [false]]);

		// Right of the last label: nothing to run, and the span still toggles as it always did.
		const collapsed = hintLine(component, 80);
		click(component, collapsed.text.length, collapsed.y, 80);
		expect(onToggleRevealed.mock.calls).toEqual([[true], [false], [true]]);
		expect(onAction).not.toHaveBeenCalled();
	});

	test("only the visible part of a truncated label runs the action", () => {
		const onAction = vi.fn<(actionId: string) => void>();
		const onToggleRevealed = vi.fn<(revealed: boolean) => void>();
		const component = new TranscriptSpanComponent(spanItem(TWO_ACTIONS), {
			renderOriginals: () => [],
			onAction,
			onToggleRevealed,
		});

		const hint = hintLine(component, 36);
		expect(hint.text).not.toContain("Inspect record");
		expect(hint.text).not.toContain("Open in context");
		expect(hint.text.endsWith("...")).toBe(true);

		const ellipsis = hint.text.indexOf("...");
		// Inside the label's range, but at columns the line had no room for.
		click(component, ellipsis, hint.y, 36);
		click(component, 35, hint.y, 36);
		expect(onAction).not.toHaveBeenCalled();
		expect(onToggleRevealed).not.toHaveBeenCalled();

		click(component, hint.text.indexOf("Inspe"), hint.y, 36);
		expect(onAction.mock.calls).toEqual([["inspect"]]);
		expect(onToggleRevealed).not.toHaveBeenCalled();
	});

	test("leaves a click on a clipped label's ellipsis alone", () => {
		const onAction = vi.fn<(actionId: string) => void>();
		const onToggleRevealed = vi.fn<(revealed: boolean) => void>();
		const width = 57;
		const component = new TranscriptSpanComponent(spanItem(TWO_ACTIONS), {
			renderOriginals: () => [],
			onAction,
			onToggleRevealed,
		});

		const hint = hintLine(component, width);
		expect(hint.text).toContain("Inspect record");
		expect(hint.text).not.toContain("Open in context");
		expect(hint.text.endsWith("...")).toBe(true);

		// The ellipsis and the columns right of it stand for the clipped part of "Open in context".
		click(component, hint.text.indexOf("..."), hint.y, width);
		click(component, width - 1, hint.y, width);
		expect(onAction).not.toHaveBeenCalled();
		expect(onToggleRevealed).not.toHaveBeenCalled();
		expect(text(component, width)).toContain("reveal originals");

		// The last column of the fully shown label in front of it still runs that action.
		click(component, hint.text.indexOf("Inspect record") + "Inspect record".length - 1, hint.y, width);
		expect(onAction.mock.calls).toEqual([["inspect"]]);
		expect(onToggleRevealed).not.toHaveBeenCalled();
	});
});
