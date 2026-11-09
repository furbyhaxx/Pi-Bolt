import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Component, Container, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import type { TranscriptProjectionProvider, TranscriptSnapshot } from "../src/core/transcript-projection.ts";
import { TranscriptSpanComponent } from "../src/modes/interactive/components/transcript-span.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

type ProjectionChange = { kind: "provider" | "invalidate" };

/** The runner surface the projection controller uses. */
interface FakeRunner {
	getTranscriptProjectionProvider(): TranscriptProjectionProvider | undefined;
	onTranscriptProjectionChange(listener: (change: ProjectionChange) => void): () => void;
}

interface FakeRunnerWithListeners extends FakeRunner {
	readonly listeners: Set<(change: ProjectionChange) => void>;
}

/** The interactive-mode state these tests drive; every method named here is the real one on the prototype. */
interface ProjectionHost {
	chatContainer: Container;
	loadedResourcesContainer: Container;
	pendingTools: Map<string, unknown>;
	toolOutputExpanded: boolean;
	outputPad: number;
	transcriptProjectionController: unknown;
	transcriptProjectionRunner: unknown;
	transcriptProjectionRefreshPending: boolean;
	session: { extensionRunner: FakeRunnerWithListeners; isStreaming: boolean };
	sessionManager: { buildContextEntries(): SessionEntry[]; getEntries(): SessionEntry[] };
	settingsManager: { getShowCacheMissNotices(): boolean };
	ui: { requestRender(): void };
	footer: { invalidate(): void };
	/** Texts of the messages the transcript rendered, in order. */
	renderedMessages: string[];
	/** Arguments of every `renderSessionItems` call. */
	renderItemsCalls: unknown[][];
	renderSessionItems(...args: unknown[]): void;
	addMessageToChat(message: AgentMessage): void;
	addCustomEntryToChat(): void;
	addCacheWarmingUsage(): void;
	addCompactionCostNotice(): void;
	showStatus(message: string): void;
}

type RenderSessionEntries = (
	this: ProjectionHost,
	entries: SessionEntry[],
	options?: { updateFooter?: boolean; populateHistory?: boolean; project?: boolean },
) => void;

type SetToolsExpanded = (this: ProjectionHost, expanded: boolean) => void;

type RebuildChat = (this: ProjectionHost) => void;

const renderSessionEntries = (InteractiveMode.prototype as unknown as { renderSessionEntries: RenderSessionEntries })
	.renderSessionEntries;
const setToolsExpanded = (InteractiveMode.prototype as unknown as { setToolsExpanded: SetToolsExpanded })
	.setToolsExpanded;
const rebuildChatFromMessages = (InteractiveMode.prototype as unknown as { rebuildChatFromMessages: RebuildChat })
	.rebuildChatFromMessages;
const realRenderSessionItems = (
	InteractiveMode.prototype as unknown as { renderSessionItems: (...args: unknown[]) => void }
).renderSessionItems;

function messageEntry(id: string, message: AgentMessage, parentId: string | null = null): SessionEntry {
	return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z", message };
}

const FIRST_PROMPT = messageEntry("e1", userMsg("first prompt"));
const FIRST_REPLY = messageEntry("e2", assistantMsg("first reply"), "e1");
const SECOND_PROMPT = messageEntry("e3", userMsg("second prompt"), "e2");
const BRANCH = [FIRST_PROMPT, FIRST_REPLY, SECOND_PROMPT];

function messageText(message: AgentMessage): string {
	if (message.role !== "user" && message.role !== "assistant") return message.role;
	const { content } = message;
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function createRunner(provider: TranscriptProjectionProvider | undefined): FakeRunnerWithListeners {
	const listeners = new Set<(change: ProjectionChange) => void>();
	return {
		listeners,
		getTranscriptProjectionProvider: () => provider,
		onTranscriptProjectionChange: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

/** A mode whose transcript renders markers instead of real message components, everything else real. */
function createHost(entries: SessionEntry[], provider: TranscriptProjectionProvider | undefined): ProjectionHost {
	const chatContainer = new Container();
	const host = Object.create(InteractiveMode.prototype) as ProjectionHost;
	const renderedMessages: string[] = [];
	host.chatContainer = chatContainer;
	host.loadedResourcesContainer = new Container();
	host.pendingTools = new Map<string, unknown>();
	host.toolOutputExpanded = false;
	host.outputPad = 1;
	host.transcriptProjectionController = undefined;
	host.transcriptProjectionRunner = undefined;
	host.transcriptProjectionRefreshPending = false;
	// `session`, `sessionManager` and `settingsManager` are getters on the prototype; own data properties shadow them.
	Object.defineProperties(host, {
		session: { value: { extensionRunner: createRunner(provider), isStreaming: false } },
		sessionManager: { value: { buildContextEntries: () => entries, getEntries: () => entries } },
		settingsManager: { value: { getShowCacheMissNotices: () => false } },
	});
	host.ui = { requestRender: () => {} };
	host.footer = { invalidate: () => {} };
	host.renderedMessages = renderedMessages;
	host.renderItemsCalls = [];
	host.renderSessionItems = (...args: unknown[]) => {
		host.renderItemsCalls.push(args);
		realRenderSessionItems.apply(host, args);
	};
	host.addMessageToChat = function (this: ProjectionHost, message: AgentMessage) {
		const text = messageText(message);
		renderedMessages.push(text);
		this.chatContainer.addChild({ render: () => [text], invalidate: () => {} });
	};
	host.addCustomEntryToChat = () => {};
	host.addCacheWarmingUsage = () => {};
	host.addCompactionCostNotice = () => {};
	host.showStatus = () => {};
	return host;
}

function spanProvider(covered: string[], project = true): TranscriptProjectionProvider {
	return {
		id: "fixture",
		project(snapshot: TranscriptSnapshot) {
			if (!project) return undefined;
			const coveredSet = new Set(covered);
			return {
				revision: snapshot.revision,
				items: [
					{
						kind: "span",
						spanId: "span-1",
						entryIds: covered,
						rows: [{ segments: [{ text: "bash npm test", tone: "text" as const }] }],
						actions: [{ id: "inspect", label: "inspect" }],
						state: "success" as const,
						label: "Audit tests",
					},
					...snapshot.entries
						.filter((entry) => !coveredSet.has(entry.id))
						.map((entry) => ({ kind: "entry" as const, entryId: entry.id })),
				],
			};
		},
		onAction: () => {},
	};
}

function invalidProvider(): TranscriptProjectionProvider {
	return {
		id: "fixture",
		project(snapshot: TranscriptSnapshot) {
			return { revision: snapshot.revision, items: [{ kind: "entry", entryId: "not-on-the-branch" }] };
		},
		onAction: () => {},
	};
}

/** Let the controller's `project()` promise settle and its refresh run. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function lines(container: Container): string {
	return stripAnsi(container.render(80).join("\n"));
}

function spans(host: ProjectionHost): TranscriptSpanComponent[] {
	return host.chatContainer.children.filter(
		(child): child is TranscriptSpanComponent => child instanceof TranscriptSpanComponent,
	);
}

function markers(host: ProjectionHost): string[] {
	return host.chatContainer.children.map((child: Component) => stripAnsi(child.render(80).join("\n")));
}

function clickFirstRow(span: TranscriptSpanComponent): void {
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		x: 0,
		y: 0,
		screenX: 0,
		screenY: 0,
		width: 80,
		height: 40,
		shift: false,
		alt: false,
		ctrl: false,
	};
	span.handleMouse(event);
}

describe("InteractiveMode transcript projection", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders a span instead of the entries it covers and reveals them once", async () => {
		const host = createHost(BRANCH, spanProvider(["e1", "e2"]));

		renderSessionEntries.call(host, BRANCH);
		// The first render is the ordinary transcript; the projection arrives afterwards.
		expect(markers(host).join("\n")).toContain("first prompt");
		host.renderedMessages.length = 0;
		await settle();

		const [span] = spans(host);
		expect(span?.spanId).toBe("span-1");
		expect(spans(host)).toHaveLength(1);
		expect(host.renderedMessages).toEqual(["second prompt"]);
		expect(lines(host.chatContainer)).toContain("Audit tests");
		expect(lines(host.chatContainer)).not.toContain("first prompt");
		expect(lines(host.chatContainer)).not.toContain("first reply");
		expect(lines(host.chatContainer)).toContain("second prompt");

		const sentinel = { toolCallId: "call-1" };
		host.pendingTools.set("call-1", sentinel);
		host.renderedMessages.length = 0;

		clickFirstRow(span!);

		expect(host.renderedMessages).toEqual(["first prompt", "first reply"]);
		expect(host.pendingTools.get("call-1")).toBe(sentinel);
		expect(host.pendingTools.size).toBe(1);
		expect(host.chatContainer.children).toContain(span);
		expect(lines(host.chatContainer)).toContain("first prompt");

		// The reveal state is the host's: a rebuild renders the span revealed again.
		host.renderedMessages.length = 0;
		rebuildChatFromMessages.call(host);
		expect(spans(host)).toHaveLength(1);
		expect(lines(host.chatContainer)).toContain("first prompt");
		expect(host.renderedMessages).toEqual(["first prompt", "first reply", "second prompt"]);
	});

	test("reveals every span of the transcript with the tools-expand action", async () => {
		const host = createHost(BRANCH, spanProvider(["e1", "e2"]));
		renderSessionEntries.call(host, BRANCH);
		await settle();
		host.renderedMessages.length = 0;

		setToolsExpanded.call(host, true);

		expect(host.toolOutputExpanded).toBe(true);
		expect(spans(host)).toHaveLength(1);
		expect(host.renderedMessages).toEqual(["first prompt", "first reply"]);

		// Collapsing takes the covered entries away again without rendering them.
		setToolsExpanded.call(host, false);
		expect(lines(host.chatContainer)).not.toContain("first prompt");
		expect(host.renderedMessages).toEqual(["first prompt", "first reply"]);
	});

	test("falls back to the ordinary transcript and warns once for a rejected projection", async () => {
		const host = createHost(BRANCH, invalidProvider());

		renderSessionEntries.call(host, BRANCH);
		host.renderedMessages.length = 0;
		await settle();

		expect(spans(host)).toHaveLength(0);
		expect(host.renderedMessages).toEqual(["first prompt", "first reply", "second prompt"]);
		const warnings = lines(host.loadedResourcesContainer);
		expect(warnings).toContain('transcript projection from "fixture" rejected (unknown-entry)');
		expect(warnings.split("rejected").length - 1).toBe(1);

		// A provider refresh that is rejected again does not warn again.
		host.renderedMessages.length = 0;
		for (const listener of host.session.extensionRunner.listeners) listener({ kind: "invalidate" });
		await settle();
		expect(spans(host)).toHaveLength(0);
		expect(new Set(host.renderedMessages)).toEqual(new Set(["first prompt", "first reply", "second prompt"]));
		expect(lines(host.loadedResourcesContainer).split("rejected").length - 1).toBe(1);
	});

	test("renders the ordinary transcript when the provider declines", async () => {
		const withoutProvider = createHost(BRANCH, undefined);
		renderSessionEntries.call(withoutProvider, BRANCH);
		const baseline = markers(withoutProvider);

		expect(withoutProvider.renderItemsCalls).toHaveLength(1);
		const [items, messageMeta] = withoutProvider.renderItemsCalls[0] as [unknown[], Map<unknown, unknown>, unknown];
		expect(items).toEqual(BRANCH.map((entry) => (entry.type === "message" ? entry.message : entry)));
		expect(messageMeta.size).toBe(3);
		expect(withoutProvider.transcriptProjectionController).toBeDefined();

		const declining = createHost(BRANCH, spanProvider(["e1", "e2"], false));
		renderSessionEntries.call(declining, BRANCH);
		await settle();

		expect(markers(declining)).toEqual(baseline);
		expect(new Set(declining.renderedMessages)).toEqual(new Set(["first prompt", "first reply", "second prompt"]));
	});

	test("does not project a partial render of the branch", () => {
		const provider = spanProvider(["e1", "e2"]);
		const project = vi.fn(provider.project);
		const host = createHost(BRANCH, { ...provider, project });

		renderSessionEntries.call(host, BRANCH, { project: false });

		expect(project).not.toHaveBeenCalled();
		expect(host.transcriptProjectionController).toBeUndefined();
		expect(spans(host)).toHaveLength(0);
		expect(host.renderedMessages).toEqual(["first prompt", "first reply", "second prompt"]);
	});
});
