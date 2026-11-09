/**
 * Transcript projection example.
 *
 * Shows registerTranscriptProjection: finished turns of the active branch collapse into one span with a short
 * summary, while the newest turns keep Pi's ordinary rendering. A span's "note" action calls back into the
 * extension, and /turn-fold off renders the ordinary transcript for comparison.
 *
 * Usage:
 *   ./pi-test.sh -e packages/coding-agent/examples/extensions/transcript-projection.ts   (source checkout)
 *   pi -e packages/coding-agent/examples/extensions/transcript-projection.ts            (installed pi)
 *   /turn-fold off|on - compare the projection with the ordinary transcript
 */

import { contentText } from "@earendil-works/pi-ai";
import type {
	Action,
	ExtensionAPI,
	ExtensionContext,
	Row,
	SessionEntry,
	SpanItem,
	TranscriptItem,
	TranscriptProjection,
	TranscriptProjectionHandle,
	TranscriptSnapshot,
	TranscriptSnapshotEntry,
} from "@earendil-works/pi-coding-agent";

/** Turns newer than this stay raw, so a running turn is never hidden behind a span. */
const RAW_TURNS = 2;
/** Longest derived text in one row; every derived text is collapsed to a single line first. */
const TEXT_LIMIT = 72;

const NOTE_ACTION: Action = { id: "note", label: "note" };

type CoveredEntry = { readonly prompt: TranscriptSnapshotEntry; readonly entry: SessionEntry };

/** One turn: a user message through every following entry until the next user message. */
type Turn = { readonly index: number; readonly entries: readonly CoveredEntry[] };

export default function transcriptProjectionExample(pi: ExtensionAPI) {
	let enabled = true;
	let branch: readonly SessionEntry[] = [];
	let context: ExtensionContext | undefined;
	let handle: TranscriptProjectionHandle | undefined;

	// The snapshot carries no message bodies, so `project()` reads the branch this cache holds.
	function project(snapshot: TranscriptSnapshot): TranscriptProjection | undefined {
		if (!enabled) return undefined;
		return { revision: snapshot.revision, items: projectBranch(snapshot, branch) };
	}

	if (typeof pi.registerTranscriptProjection === "function") {
		handle = pi.registerTranscriptProjection({
			id: "turn-fold",
			project,
			onAction(spanId, actionId) {
				if (actionId !== NOTE_ACTION.id) return;
				context?.ui.notify(`${spanId}: "${actionId}" reached the projection example`, "info");
			},
		});
	}

	function refresh(ctx: ExtensionContext) {
		context = ctx;
		branch = ctx.sessionManager.getBranch();
		handle?.invalidate();
	}

	pi.on("session_start", (_event, ctx) => refresh(ctx));
	pi.on("session_tree", (_event, ctx) => refresh(ctx));
	pi.on("agent_end", (_event, ctx) => refresh(ctx));

	pi.registerCommand("turn-fold", {
		description:
			"Fold finished transcript turns into spans, or show the ordinary transcript (usage: /turn-fold on|off)",
		handler: async (args, ctx) => {
			context = ctx;
			const choice = args.trim().toLowerCase();
			if (choice === "on" || choice === "off") enabled = choice === "on";
			ctx.ui.notify(`turn folding ${enabled ? "on" : "off"} (usage: /turn-fold on|off)`, "info");
			handle?.invalidate();
		},
	});
}

function projectBranch(snapshot: TranscriptSnapshot, branch: readonly SessionEntry[]): TranscriptItem[] {
	const bodies = new Map(branch.map((entry) => [entry.id, entry]));
	const covered: CoveredEntry[] = [];
	for (const prompt of snapshot.entries) {
		const entry = bodies.get(prompt.id);
		// Entries the cache has not seen yet stay uncovered, so the host renders them raw.
		if (entry === undefined) break;
		covered.push({ prompt, entry });
	}

	const firstPrompt = covered.findIndex(({ entry }) => isUserMessage(entry));
	if (firstPrompt < 0) return covered.map(asEntryItem);

	const turns = splitTurns(covered.slice(firstPrompt));
	const foldedTurns = Math.max(0, turns.length - RAW_TURNS);
	const items: TranscriptItem[] = covered.slice(0, firstPrompt).map(asEntryItem);
	for (const turn of turns) {
		if (turn.index <= foldedTurns && isComplete(turn.entries)) items.push(spanFor(turn));
		else items.push(...turn.entries.map(asEntryItem));
	}
	return items;
}

function splitTurns(covered: readonly CoveredEntry[]): Turn[] {
	const groups: CoveredEntry[][] = [];
	for (const item of covered) {
		if (isUserMessage(item.entry)) groups.push([]);
		groups[groups.length - 1].push(item);
	}
	return groups.map((entries, position) => ({ index: position + 1, entries }));
}

/** A turn is complete once the model answered and the turn no longer waits for a prompt. */
function isComplete(entries: readonly CoveredEntry[]): boolean {
	const last = entries[entries.length - 1];
	if (last.entry.type === "message" && last.entry.message.role === "user") return false;
	return entries.some(({ entry }) => entry.type === "message" && entry.message.role === "assistant");
}

function spanFor(turn: Turn): SpanItem {
	let assistants = 0;
	let toolCalls = 0;
	const tools: string[] = [];
	let lastText = "";
	for (const { entry } of turn.entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		assistants += 1;
		for (const block of entry.message.content) {
			if (block.type !== "toolCall") continue;
			toolCalls += 1;
			tools.push(block.name);
		}
		const text = lastLine(contentText(entry.message.content));
		if (text.length > 0) lastText = text;
	}

	const start = turn.entries[0].entry;
	const prompt =
		start.type === "message" && start.message.role === "user" ? firstLine(contentText(start.message.content)) : "";
	const rows: Row[] = [
		{ segments: [{ text: prompt || "(no prompt text)", tone: "text", bold: true }] },
		{
			indent: 1,
			segments: [{ text: `${count(assistants, "assistant")} · ${count(toolCalls, "tool call")}`, tone: "dim" }],
		},
	];
	const toolNames = [...new Set(tools)];
	if (toolNames.length > 0) {
		rows.push({ indent: 1, segments: [{ text: clamp(`tools: ${toolNames.join(", ")}`), tone: "muted" }] });
	}
	if (lastText.length > 0) rows.push({ indent: 1, segments: [{ text: lastText, tone: "muted" }] });

	return {
		kind: "span",
		spanId: `turn-${turn.index}`,
		entryIds: turn.entries.map(({ prompt: entry }) => entry.id),
		rows,
		actions: [NOTE_ACTION],
		state: "success",
		label: `turn ${turn.index}`,
	};
}

function isUserMessage(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "user";
}

function asEntryItem({ prompt }: CoveredEntry): TranscriptItem {
	return { kind: "entry", entryId: prompt.id };
}

function count(amount: number, noun: string): string {
	return `${amount} ${noun}${amount === 1 ? "" : "s"}`;
}

function firstLine(text: string): string {
	return clamp(text.split("\n").find((line) => line.trim().length > 0) ?? "");
}

function lastLine(text: string): string {
	const lines = text.split("\n").reverse();
	return clamp(lines.find((line) => line.trim().length > 0) ?? "");
}

function clamp(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length <= TEXT_LIMIT ? line : `${line.slice(0, TEXT_LIMIT - 1)}…`;
}
