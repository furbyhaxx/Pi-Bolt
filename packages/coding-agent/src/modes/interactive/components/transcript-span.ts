import { type Component, Container, MouseRegion, TruncatedText } from "@earendil-works/pi-tui";
import {
	type Action,
	type Row,
	type SpanItem,
	type Tone,
	TRANSCRIPT_PROJECTION_LIMITS,
} from "../../../core/transcript-projection.ts";
import { theme } from "../theme/theme.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

/** The state word for each tone: color alone never carries the state. */
const STATE_WORDS: Record<Tone, string> = {
	text: "info",
	muted: "waiting",
	dim: "idle",
	accent: "running",
	success: "done",
	warning: "warning",
	error: "failed",
};

/** What a projected span needs from its host. */
export interface TranscriptSpanOptions {
	/** Left and right padding of every line, in columns; the transcript's output pad. */
	outputPad?: number;
	/** Whether the covered entries render beneath the span from the start. */
	revealed?: boolean;
	/** Provider rows shown while collapsed; the others are counted on one line. */
	collapsedRowsLimit?: number;
	/** The covered entries' own components, made when the span is revealed. */
	renderOriginals: () => Component[];
	/** Called after a click toggles the span, with its new reveal state, so the host can record it. */
	onToggleRevealed?: (revealed: boolean) => void;
}

/** Renders one projected span as a compact record in place of the entries it covers. */
export class TranscriptSpanComponent extends Container {
	/** The projected span this renders, stable for the component's life. */
	readonly spanId: string;
	private readonly item: SpanItem;
	private readonly renderOriginals: () => Component[];
	private readonly onToggleRevealed: ((revealed: boolean) => void) | undefined;
	private outputPad: number;
	private revealed: boolean;
	private collapsedRowsLimit: number;
	/** The covered entries' components while revealed; a collapse or invalidate() drops them. */
	private originals?: Component[];

	constructor(item: SpanItem, options: TranscriptSpanOptions) {
		super();
		this.spanId = item.spanId;
		this.item = item;
		this.renderOriginals = options.renderOriginals;
		this.onToggleRevealed = options.onToggleRevealed;
		this.outputPad = options.outputPad ?? 1;
		this.revealed = options.revealed ?? false;
		this.collapsedRowsLimit = options.collapsedRowsLimit ?? TRANSCRIPT_PROJECTION_LIMITS.maxRowsPerSpan;
		this.updateDisplay();
	}

	setRevealed(revealed: boolean): void {
		if (this.revealed === revealed) return;
		this.revealed = revealed;
		if (!revealed) this.originals = undefined;
		this.updateDisplay();
	}

	setOutputPad(outputPad: number): void {
		if (this.outputPad === outputPad) return;
		this.outputPad = outputPad;
		this.updateDisplay();
	}

	override invalidate(): void {
		this.originals = undefined;
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();
		const content = new Container();
		content.addChild(new TruncatedText(this.headline(), this.outputPad, 0));

		const rows = this.revealed ? this.item.rows : this.item.rows.slice(0, this.collapsedRowsLimit);
		for (const row of rows) {
			content.addChild(new TruncatedText(rowLine(row), this.outputPad, 0));
		}
		const folded = this.item.rows.length - rows.length;
		if (folded > 0) {
			content.addChild(new TruncatedText(theme.fg("muted", `  ... ${folded} more rows`), this.outputPad, 0));
		}
		content.addChild(new TruncatedText(this.hintLine(), this.outputPad, 0));

		this.addChild(
			new MouseRegion(content, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setRevealed(!this.revealed);
				this.onToggleRevealed?.(this.revealed);
				return { handled: true };
			}),
		);

		if (!this.revealed) return;
		if (this.originals === undefined) this.originals = this.renderOriginals();
		this.addChild(
			new TruncatedText(theme.fg("dim", `── original entries (${this.item.entryIds.length}) ──`), this.outputPad, 0),
		);
		for (const original of this.originals) {
			this.addChild(original);
		}
	}

	private headline(): string {
		const marker = theme.fg("muted", this.revealed ? "▾ " : "▸ ");
		const state = theme.fg(this.item.state, STATE_WORDS[this.item.state]);
		return `${marker}${state} ${theme.fg("text", theme.bold(this.item.label))}`;
	}

	private hintLine(): string {
		// (The host's own action first: it is the one a narrow line must keep.)
		const parts = [keyHint("app.tools.expand", this.revealed ? "collapse" : "reveal originals")];
		parts.push(...this.item.actions.map(actionHint));
		return parts.join(theme.fg("dim", " · "));
	}
}

function rowLine(row: Row): string {
	let line = " ".repeat(2 + (row.indent ?? 0) * 2);
	for (const segment of row.segments) {
		line += theme.fg(segment.tone, segment.bold ? theme.bold(segment.text) : segment.text);
	}
	return line;
}

function actionHint(action: Action): string {
	return action.key === undefined ? theme.fg("muted", action.label) : rawKeyHint(action.key, action.label);
}
