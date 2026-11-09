import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent, ToolCall, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import transcriptProjection from "../examples/extensions/transcript-projection.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import type {
	SpanItem,
	TranscriptProjection,
	TranscriptProjectionProvider,
	TranscriptSnapshot,
} from "../src/core/transcript-projection.ts";
import { validateTranscriptProjection } from "../src/core/transcript-projection.ts";

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function entry(id: string, parentId: string | null, message: AgentMessage): SessionEntry {
	return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z", message };
}

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function text(value: string): TextContent {
	return { type: "text", text: value };
}

function toolCall(id: string, name: string): ToolCall {
	return { type: "toolCall", id, name, arguments: {} };
}

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage,
		stopReason,
		timestamp: 0,
	};
}

function toolResult(toolCallId: string, toolName: string): AgentMessage {
	return { role: "toolResult", toolCallId, toolName, content: [text("ok")], isError: false, timestamp: 0 };
}

/** Two leading non-user entries and five turns; turn 2 uses a tool, turn 3 aborted mid-turn. */
const BRANCH: SessionEntry[] = [
	{
		type: "model_change",
		id: "m0",
		parentId: null,
		timestamp: "2026-01-01T00:00:00Z",
		provider: "anthropic",
		modelId: "test",
	},
	{ type: "custom", id: "c0", parentId: "m0", timestamp: "2026-01-01T00:00:01Z", customType: "preamble" },
	entry("u1", "c0", user("First question\nwith a second line")),
	entry("a1", "u1", assistant([text("first answer")])),
	entry("u2", "a1", user("Run the tests")),
	entry("a2", "u2", assistant([text("running"), toolCall("t1", "bash")], "toolUse")),
	entry("r2", "a2", toolResult("t1", "bash")),
	entry("a3", "r2", assistant([text("tests pass")])),
	entry("u3", "a3", user("Now refactor")),
	entry("b3", "u3", assistant([text("partial refactor")], "aborted")),
	entry("u4", "b3", user("Fourth prompt")),
	entry("a4", "u4", assistant([text("fourth answer")])),
	entry("u5", "a4", user("Fifth prompt")),
	entry("a5", "u5", assistant([text("fifth answer")])),
];

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;

function snapshotOf(entries: readonly SessionEntry[], revision = 1): TranscriptSnapshot {
	return {
		revision,
		leafId: entries.length === 0 ? "" : entries[entries.length - 1].id,
		entries: entries.map((item) => ({
			id: item.id,
			parentId: item.parentId,
			kind: item.type,
			role: item.type === "message" ? item.message.role : undefined,
			timestamp: item.timestamp,
		})),
	};
}

function setup(branch: readonly SessionEntry[]) {
	const handlers = new Map<string, EventHandler>();
	const invalidate = vi.fn();
	const notify = vi.fn();
	let provider: TranscriptProjectionProvider | undefined;
	let command: CommandHandler | undefined;

	const api = {
		on(event: string, handler: EventHandler) {
			handlers.set(event, handler);
			return () => {};
		},
		registerTranscriptProjection(value: TranscriptProjectionProvider) {
			provider = value;
			return { invalidate };
		},
		registerCommand(_name: string, options: { handler: CommandHandler }) {
			command = options.handler;
		},
	} as unknown as ExtensionAPI;

	transcriptProjection(api);

	const ctx = {
		mode: "tui",
		ui: { notify },
		sessionManager: { getBranch: () => branch },
	} as unknown as ExtensionContext;

	return {
		/** Emit a lifecycle event; the extension then reads `branch` through the context. */
		emit(event: string) {
			handlers.get(event)!(undefined, ctx);
		},
		async project(snapshot: TranscriptSnapshot): Promise<TranscriptProjection | undefined> {
			return (await provider!.project(snapshot)) ?? undefined;
		},
		async runCommand(args: string) {
			await command!(args, ctx);
		},
		async action(spanId: string, actionId: string) {
			await provider!.onAction(spanId, actionId);
		},
		invalidate,
		notify,
	};
}

function rowTexts(span: SpanItem): string[] {
	return span.rows.map((row) => row.segments.map((segment) => segment.text).join(""));
}

describe("transcript-projection example", () => {
	const snapshot = snapshotOf(BRANCH);

	it("folds every complete turn except the newest two", async () => {
		const extension = setup(BRANCH);
		extension.emit("session_start");
		expect(extension.invalidate).toHaveBeenCalledTimes(1);

		const projection = await extension.project(snapshot);
		if (projection === undefined) throw new Error("the example projected nothing");
		const validation = validateTranscriptProjection(
			BRANCH.map((item) => item.id),
			projection,
		);
		if (!validation.ok) throw new Error(`${validation.reason}: ${validation.detail}`);
		const items = validation.items;

		expect(items.map((item) => item.kind)).toEqual([
			"entry",
			"entry",
			"span",
			"span",
			"span",
			"entry",
			"entry",
			"entry",
			"entry",
		]);
		const spans = items.filter((item): item is SpanItem => item.kind === "span");
		expect(spans.map((span) => span.spanId)).toEqual(["turn-1", "turn-2", "turn-3"]);
		expect(spans.map((span) => span.label)).toEqual(["turn 1", "turn 2", "turn 3"]);
		expect(spans.map((span) => span.state)).toEqual(["success", "success", "success"]);
		expect(spans[1].entryIds).toEqual(["u2", "a2", "r2", "a3"]);
		expect(spans[0].actions).toEqual([{ id: "note", label: "note" }]);

		// Coverage is the branch prefix in order, without gaps or duplicates.
		const covered = items.flatMap((item) => (item.kind === "entry" ? [item.entryId] : item.entryIds));
		expect(covered).toEqual(BRANCH.map((item) => item.id).slice(0, covered.length));
		expect(items.slice(5)).toEqual([
			{ kind: "entry", entryId: "u4" },
			{ kind: "entry", entryId: "a4" },
			{ kind: "entry", entryId: "u5" },
			{ kind: "entry", entryId: "a5" },
		]);

		expect(rowTexts(spans[0])).toEqual(["First question", "1 assistant · 0 tool calls", "first answer"]);
		expect(rowTexts(spans[1])).toEqual(["Run the tests", "2 assistants · 1 tool call", "tools: bash", "tests pass"]);
		expect(rowTexts(spans[2])).toEqual(["Now refactor", "1 assistant · 0 tool calls", "partial refactor"]);
	});

	it("leaves entries the cache has not seen yet raw", async () => {
		const extension = setup(BRANCH);
		extension.emit("agent_end");

		const streaming = [
			...BRANCH,
			entry("u6", "a5", user("Sixth prompt")),
			entry("a6", "u6", assistant([text("sixth answer")])),
		];
		const projection = await extension.project(snapshotOf(streaming));
		if (projection === undefined) throw new Error("the example projected nothing");
		const validation = validateTranscriptProjection(
			streaming.map((item) => item.id),
			projection,
		);
		if (!validation.ok) throw new Error(`${validation.reason}: ${validation.detail}`);
		expect(validation.items.slice(-2)).toEqual([
			{ kind: "entry", entryId: "u6" },
			{ kind: "entry", entryId: "a6" },
		]);
		expect(validation.items.filter((item) => item.kind === "span")).toHaveLength(3);

		// A turn cut mid-stream stays raw instead of folding a partial turn.
		const cut = setup(BRANCH.slice(0, 13));
		cut.emit("agent_end");
		const cutProjection = await cut.project(snapshotOf(BRANCH));
		if (cutProjection === undefined) throw new Error("the example projected nothing");
		const cutValidation = validateTranscriptProjection(
			BRANCH.map((item) => item.id),
			cutProjection,
		);
		if (!cutValidation.ok) throw new Error(`${cutValidation.reason}: ${cutValidation.detail}`);
		expect(cutValidation.items.filter((item) => item.kind === "span")).toHaveLength(3);
		expect(cutValidation.items.slice(-2)).toEqual([
			{ kind: "entry", entryId: "u5" },
			{ kind: "entry", entryId: "a5" },
		]);
	});

	it("toggles between the projection and the ordinary transcript", async () => {
		const extension = setup(BRANCH);
		extension.emit("session_start");

		await extension.runCommand("off");
		expect(await extension.project(snapshot)).toBeUndefined();

		await extension.runCommand("on");
		expect(await extension.project(snapshot)).toBeDefined();
	});

	it("refreshes on lifecycle events and reports a span action", async () => {
		const extension = setup(BRANCH);
		extension.emit("session_start");
		extension.emit("session_tree");
		extension.emit("agent_end");
		expect(extension.invalidate).toHaveBeenCalledTimes(3);

		await extension.action("turn-1", "note");
		expect(extension.notify).toHaveBeenCalledTimes(1);
		await extension.action("turn-1", "unknown");
		expect(extension.notify).toHaveBeenCalledTimes(1);
	});
});
