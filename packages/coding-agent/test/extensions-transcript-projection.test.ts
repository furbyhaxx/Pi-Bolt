/**
 * Tests for transcript projection providers: one provider per session, the runner accessor, and removal on unload.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type {
	ExtensionActions,
	ExtensionAPI,
	ExtensionContextActions,
	ExtensionError,
} from "../src/core/extensions/types.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { TranscriptProjectionProvider } from "../src/core/transcript-projection.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

describe("transcript projection providers", () => {
	let tempDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-transcript-projection-test-"));
		sessionManager = SessionManager.inMemory();
		modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const extensionActions: ExtensionActions = {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		getSettings: () => ({}),
		setActiveTools: () => {},
		refreshTools: () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
	};

	const extensionContextActions: ExtensionContextActions = {
		getModel: () => undefined,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getSignal: () => undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		getScopedModels: () => [],
	};

	function provider(id: string): TranscriptProjectionProvider {
		return { id, project: () => undefined, onAction: () => {} };
	}

	it("keeps the first provider and reports every registration of another extension", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		const first = provider("first");
		const firstExtension = await loadExtensionFromFactory(
			(pi) => pi.registerTranscriptProjection(first),
			tempDir,
			eventBus,
			runtime,
			"<inline:first>",
		);
		const secondExtension = await loadExtensionFromFactory(
			(pi) => pi.registerTranscriptProjection(provider("second")),
			tempDir,
			eventBus,
			runtime,
			"<inline:second>",
		);
		const runner = new ExtensionRunner(
			[firstExtension, secondExtension],
			runtime,
			tempDir,
			sessionManager,
			modelRegistry,
		);
		const errors: ExtensionError[] = [];
		runner.onError((error) => errors.push(error));
		runner.bindCore(extensionActions, extensionContextActions);

		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ extensionPath: "<inline:second>", event: "transcript_projection" });
		expect(errors[0].error).toContain('"second"');
		expect(errors[0].error).toContain("<inline:first>");
		expect(runner.getTranscriptProjectionProvider()).toBe(first);

		// After binding, a registration from another extension is rejected right away.
		await loadExtensionFromFactory(
			(pi) => pi.registerTranscriptProjection(provider("third")),
			tempDir,
			eventBus,
			runtime,
			"<inline:third>",
		);
		expect(errors).toHaveLength(2);
		expect(errors[1]).toMatchObject({ extensionPath: "<inline:third>", event: "transcript_projection" });
		expect(errors[1].error).toContain('"third"');
		expect(runner.getTranscriptProjectionProvider()).toBe(first);
	});

	it("lets the owner replace its own provider and drops the provider when the extensions unload", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		const first = provider("first");
		const next = provider("next");
		let api: ExtensionAPI | undefined;
		const extension = await loadExtensionFromFactory(
			(pi) => {
				api = pi;
				pi.registerTranscriptProjection(first);
			},
			tempDir,
			eventBus,
			runtime,
			"<inline:owner>",
		);
		const runner = new ExtensionRunner([extension], runtime, tempDir, sessionManager, modelRegistry);
		const errors: ExtensionError[] = [];
		runner.onError((error) => errors.push(error));
		runner.bindCore(extensionActions, extensionContextActions);
		const changes: Array<TranscriptProjectionProvider | undefined> = [];
		runner.onTranscriptProjectionChange(() => changes.push(runner.getTranscriptProjectionProvider()));

		expect(runner.getTranscriptProjectionProvider()).toBe(first);

		if (api === undefined) throw new Error("the extension did not run");
		api.registerTranscriptProjection(next);
		expect(errors).toEqual([]);
		expect(runner.getTranscriptProjectionProvider()).toBe(next);

		runner.invalidate();
		expect(runner.getTranscriptProjectionProvider()).toBeUndefined();
		expect(changes).toEqual([next, undefined]);
	});
});
