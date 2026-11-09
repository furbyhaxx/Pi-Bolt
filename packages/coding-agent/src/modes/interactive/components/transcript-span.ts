import {
	type Component,
	Container,
	MouseRegion,
	TruncatedText,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
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
	/** Called when a left click hits one of the span's action labels; a click elsewhere still toggles. */
	onAction?: (actionId: string) => void;
}

/** Renders one projected span as a compact record in place of the entries it covers. */
export class TranscriptSpanComponent extends Container {
	/** The projected span this renders, stable for the component's life. */
	readonly spanId: string;
	private readonly item: SpanItem;
	private readonly renderOriginals: () => Component[];
	private readonly onToggleRevealed: ((revealed: boolean) => void) | undefined;
	private readonly onAction: ((actionId: string) => void) | undefined;
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
		this.onAction = options.onAction;
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
			content.addChild(new RowText(row, this.outputPad));
		}
		const folded = this.item.rows.length - rows.length;
		if (folded > 0) {
			content.addChild(new TruncatedText(theme.fg("muted", `  ... ${folded} more rows`), this.outputPad, 0));
		}
		content.addChild(new SpanHintLine(this.hintLabels(), this.outputPad, this.onAction));

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

	private hintLabels(): HintLabel[] {
		// (The host's own action first: it is the one a narrow line must keep.)
		return [
			{ text: keyHint("app.tools.expand", this.revealed ? "collapse" : "reveal originals") },
			...this.item.actions.map((action) => ({ text: actionHint(action), actionId: action.id })),
		];
	}
}

/** One label of the hint line; only a provider action label carries the action a click runs. */
interface HintLabel {
	readonly text: string;
	readonly actionId?: string;
}

/** What a click on the hint line covers. */
type HintHit = { kind: "action"; actionId: string } | { kind: "clipped" };

/** Separates the hint line's labels. */
const HINT_SEPARATOR = " · ";
/** The ellipsis TruncatedText appends to a line that is too wide for it. */
const TRUNCATION_ELLIPSIS = "...";

/**
 * The hint line, with every provider action label a click target of its own. A click on the host's own
 * hint or on the separators reaches the span's reveal toggle, which wraps this line; a click on the
 * columns of a label the line had no room for reaches nothing.
 */
class SpanHintLine implements Component {
	private readonly labels: readonly HintLabel[];
	private readonly paddingX: number;
	private readonly onAction: ((actionId: string) => void) | undefined;

	constructor(labels: readonly HintLabel[], paddingX: number, onAction: ((actionId: string) => void) | undefined) {
		this.labels = labels;
		this.paddingX = paddingX;
		this.onAction = onAction;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return new TruncatedText(this.line(), this.paddingX, 0).render(width);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left" || event.y !== 0) return undefined;
		const hit = this.hitAt(event.x, event.width);
		if (hit === undefined) return undefined;
		if (hit.kind === "action") this.onAction?.(hit.actionId);
		return { handled: true };
	}

	private line(): string {
		return this.labels.map((label) => label.text).join(theme.fg("dim", HINT_SEPARATOR));
	}

	/**
	 * What column `x` covers: a label's action, or the ellipsis and the columns it stands for, which belong to a
	 * clipped action label and so neither run anything nor reach the reveal toggle.
	 */
	private hitAt(x: number, width: number): HintHit | undefined {
		const available = Math.max(1, width - this.paddingX * 2);
		const line = this.line();
		const shown = truncateToWidth(line, available);
		const truncated = visibleWidth(shown) < visibleWidth(line);
		// TruncatedText's last columns of a cut line are the ellipsis, which stands for the labels' hidden text.
		const contentEnd = this.paddingX + visibleWidth(shown) - (truncated ? visibleWidth(TRUNCATION_ELLIPSIS) : 0);
		if (x < this.paddingX) return undefined;

		let column = this.paddingX;
		let clipped = false;
		for (const [index, label] of this.labels.entries()) {
			if (index > 0) column += visibleWidth(HINT_SEPARATOR);
			const labelEnd = column + visibleWidth(label.text);
			if (label.actionId !== undefined) {
				if (x >= column && x < Math.min(labelEnd, contentEnd)) return { kind: "action", actionId: label.actionId };
				if (labelEnd > contentEnd) clipped = true;
			}
			column = labelEnd;
		}
		return clipped && x >= contentEnd ? { kind: "clipped" } : undefined;
	}
}

/** A narrowed segment keeps no less than this many columns, enough for its ellipsis. */
const MIN_SHRUNK_SEGMENT_WIDTH = 3;

/** One projected row; the row is only sized once its width is known, so a narrow row can shrink a segment first. */
class RowText implements Component {
	private readonly row: Row;
	private readonly paddingX: number;

	constructor(row: Row, paddingX: number) {
		this.row = row;
		this.paddingX = paddingX;
	}

	/** No cached state: the line is rebuilt for the width it is asked to render at. */
	invalidate(): void {}

	render(width: number): string[] {
		// Same horizontal padding TruncatedText applies, which owns the right truncation that follows the shrink.
		const availableWidth = Math.max(1, width - this.paddingX * 2);
		return new TruncatedText(rowLine(this.row, availableWidth), this.paddingX, 0).render(width);
	}
}

function rowLine(row: Row, availableWidth: number): string {
	const prefix = " ".repeat(2 + (row.indent ?? 0) * 2);
	const parts = row.segments.map((segment) => {
		const text = theme.fg(segment.tone, segment.bold ? theme.bold(segment.text) : segment.text);
		return { text, width: visibleWidth(text), shrinkable: segment.shrink === true };
	});

	let overflow = visibleWidth(prefix) + parts.reduce((sum, part) => sum + part.width, 0) - availableWidth;
	for (const part of parts) {
		if (overflow <= 0) break;
		if (!part.shrinkable || part.width <= MIN_SHRUNK_SEGMENT_WIDTH) continue;
		const narrowed = Math.max(MIN_SHRUNK_SEGMENT_WIDTH, part.width - overflow);
		overflow -= part.width - narrowed;
		part.width = narrowed;
	}

	return prefix + parts.map((part) => truncateToWidth(part.text, part.width)).join("");
}

function actionHint(action: Action): string {
	return action.key === undefined ? theme.fg("muted", action.label) : rawKeyHint(action.key, action.label);
}
