import { type Component, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
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
});
