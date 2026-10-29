import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

describe("ordinary resource inventory", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;
	let theme: Record<string, unknown>;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "resource-inventory-"));
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		vi.stubEnv("HOME", root);
		theme = JSON.parse(readFileSync(join(process.cwd(), "src/modes/interactive/theme/dark.json"), "utf8"));
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it("freezes the ordinary resolution before overrides and extension discoveries", async () => {
		const extensionDir = join(agentDir, "extensions");
		const skillDir = join(root, "skill-root");
		const promptDir = join(root, "prompt-root");
		const themeDir = join(root, "theme-root");
		const extraDir = join(root, "extra");
		for (const dir of [extensionDir, join(skillDir, "nested"), promptDir, themeDir, extraDir]) {
			mkdirSync(dir, { recursive: true });
		}
		const enabledExtension = join(extensionDir, "enabled.ts");
		const disabledExtension = join(extensionDir, "disabled.ts");
		const skill = join(skillDir, "nested", "SKILL.md");
		const prompt = join(promptDir, "prompt.md");
		const themePath = join(themeDir, "theme.json");
		const extraPrompt = join(extraDir, "extra.md");
		writeFileSync(enabledExtension, "export default function() {};");
		writeFileSync(disabledExtension, "throw new Error('disabled extension loaded');");
		writeFileSync(skill, "---\nname: nested\ndescription: Nested skill\n---\nSkill");
		writeFileSync(prompt, "Prompt");
		writeFileSync(themePath, JSON.stringify({ ...theme, name: "inventory-theme" }));
		writeFileSync(extraPrompt, "Extra prompt");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["-extensions/disabled.ts"] }));
		const settingsManager = SettingsManager.create(cwd, agentDir);
		let fail = false;
		let factoryCalls = 0;
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			additionalSkillPaths: [skillDir],
			additionalPromptTemplatePaths: [promptDir],
			additionalThemePaths: [themeDir],
			extensionFactories: [
				{ name: "built", builtin: true, factory: () => void factoryCalls++ },
				{
					name: "discover",
					factory: (pi) => {
						factoryCalls++;
						pi.on("resources_discover", async () => ({ promptPaths: [extraPrompt] }));
					},
				},
			],
			extensionsOverride: (base) => {
				base.extensions = base.extensions.filter((extension) => extension.path !== enabledExtension);
				return base;
			},
			skillsOverride: (base) => {
				if (base.skills[0]) base.skills[0].filePath = "/mutated-skill";
				return { skills: [], diagnostics: base.diagnostics };
			},
			promptsOverride: (base) => {
				if (fail) throw new Error("failed override");
				return {
					prompts: base.prompts.filter((item) => item.filePath === extraPrompt),
					diagnostics: base.diagnostics,
				};
			},
			themesOverride: (base) => {
				if (base.themes[0]) Reflect.set(base.themes[0], "sourcePath", "/mutated-theme");
				return { themes: [], diagnostics: base.diagnostics };
			},
		});

		expect(() => loader.getResourceInventory()).toThrow(/reload/i);
		await loader.reload();
		expect(factoryCalls).toBe(2);
		expect(loader.getExtensions().extensions.some((extension) => extension.path === enabledExtension)).toBe(false);
		const initial = loader.getResourceInventory();
		const lookup = (kind: string, path: string) =>
			initial.entries.find((entry) => entry.kind === kind && entry.path === path);
		expect(lookup("extension", enabledExtension)).toMatchObject({ enabled: true, sourceInfo: { scope: "user" } });
		expect(lookup("extension", disabledExtension)).toMatchObject({ enabled: false, sourceInfo: { scope: "user" } });
		expect(lookup("extension", "builtin:built")).toMatchObject({ enabled: true });
		expect(lookup("extension", "<inline:discover>")).toMatchObject({ enabled: true });
		expect(
			initial.entries.filter((entry) => entry.kind === "extension" && entry.enabled).map((entry) => entry.path),
		).toEqual([enabledExtension, "builtin:built", "<inline:discover>"]);
		expect(lookup("skill", skill)).toMatchObject({ enabled: true });
		expect(lookup("prompt", prompt)).toMatchObject({ enabled: true });
		expect(lookup("theme", themePath)).toMatchObject({ enabled: true });
		expect(initial.entries.some((entry) => entry.path.startsWith("/mutated-"))).toBe(false);
		expect(new Set(initial.entries.map((entry) => entry.id)).size).toBe(initial.entries.length);
		expect(Object.isFrozen(initial)).toBe(true);
		expect(Object.isFrozen(initial.entries)).toBe(true);
		const originalEntry = lookup("skill", skill);
		expect(Object.isFrozen(originalEntry)).toBe(true);
		expect(Object.isFrozen(originalEntry?.sourceInfo)).toBe(true);
		expect(() => Reflect.set(originalEntry?.sourceInfo ?? {}, "source", "tampered")).not.toThrow();
		expect(lookup("skill", skill)?.sourceInfo.source).not.toBe("tampered");

		const extensions = loader.getExtensions();
		const runner = new ExtensionRunner(
			extensions.extensions,
			extensions.runtime,
			cwd,
			SessionManager.inMemory(),
			await createModelRegistry(AuthStorage.create(join(root, "auth.json"))),
		);
		const discovered = await runner.emitResourcesDiscover(cwd, "startup");
		const laterPrompt = join(promptDir, "later.md");
		writeFileSync(laterPrompt, "Later");
		loader.extendResources({
			promptPaths: discovered.promptPaths.map(({ path, extensionPath }) => ({
				path,
				metadata: { source: `extension:${extensionPath}`, scope: "temporary", origin: "top-level" },
			})),
		});
		expect(loader.getPrompts().prompts.map((item) => item.filePath)).toContain(extraPrompt);
		expect(factoryCalls).toBe(2);
		expect(loader.getResourceInventory().entries.some((entry) => entry.path === laterPrompt)).toBe(false);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["-extensions/enabled.ts"] }));
		expect(loader.getResourceInventory()).toEqual(initial);
		expect(loader.getResourceInventory().entries.some((entry) => entry.path === extraPrompt)).toBe(false);

		fail = true;
		await expect(loader.reload()).rejects.toThrow("failed override");
		expect(loader.getResourceInventory()).toEqual(initial);
		fail = false;
		await loader.reload();
		const next = loader.getResourceInventory();
		expect(next.generation).not.toBe(initial.generation);
		expect(next.entries.find((entry) => entry.path === enabledExtension)).toMatchObject({ enabled: false });
		expect(next.entries.find((entry) => entry.path === disabledExtension)).toMatchObject({ enabled: true });
		expect(next.entries.find((entry) => entry.path === laterPrompt)).toMatchObject({ enabled: true });
		expect(next.entries.find((entry) => entry.path === skill)?.id).toBe(originalEntry?.id);
		expect(initial.entries.some((entry) => entry.path === laterPrompt)).toBe(false);
	});

	it("retains collision candidates and disabled resources across kinds", async () => {
		const first = join(root, "first");
		const second = join(root, "second");
		for (const dir of [first, second]) {
			for (const type of ["skills", "prompts", "themes"]) mkdirSync(join(dir, type), { recursive: true });
			writeFileSync(join(dir, "skills", "SKILL.md"), "---\nname: duplicate\ndescription: Duplicate\n---\nSkill");
			writeFileSync(join(dir, "prompts", "duplicate.md"), "Prompt");
			writeFileSync(join(dir, "themes", "theme.json"), JSON.stringify({ ...theme, name: "duplicate" }));
		}
		const disabledSkill = join(agentDir, "skills", "skip", "SKILL.md");
		const disabledPrompt = join(agentDir, "prompts", "skip.md");
		const disabledTheme = join(agentDir, "themes", "skip.json");
		for (const dir of [join(agentDir, "skills", "skip"), join(agentDir, "prompts"), join(agentDir, "themes")]) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(disabledSkill, "---\nname: skip\ndescription: Skip\n---\nSkill");
		writeFileSync(disabledPrompt, "Prompt");
		writeFileSync(disabledTheme, JSON.stringify({ ...theme, name: "skip" }));
		const settingsManager = SettingsManager.inMemory({
			skills: ["-skills/skip"],
			prompts: ["-prompts/skip.md"],
			themes: ["-themes/skip.json"],
		});
		const shared = join(root, "shared.md");
		writeFileSync(shared, "---\nname: shared\ndescription: Shared\n---\nContent");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			additionalSkillPaths: [join(first, "skills"), join(second, "skills"), shared],
			additionalPromptTemplatePaths: [join(first, "prompts"), join(second, "prompts"), shared],
			additionalThemePaths: [join(first, "themes"), join(second, "themes")],
		});
		await loader.reload();
		const { entries } = loader.getResourceInventory();
		for (const dir of [first, second]) {
			for (const [kind, path] of [
				["skill", join(dir, "skills", "SKILL.md")],
				["prompt", join(dir, "prompts", "duplicate.md")],
				["theme", join(dir, "themes", "theme.json")],
			] as const) {
				expect(entries.find((entry) => entry.kind === kind && entry.path === path)).toMatchObject({
					enabled: true,
				});
			}
		}
		for (const path of [disabledSkill, disabledPrompt, disabledTheme]) {
			expect(entries.find((entry) => entry.path === path)).toMatchObject({ enabled: false });
		}
		const sharedSkill = entries.find((entry) => entry.path === shared && entry.kind === "skill");
		const sharedPrompt = entries.find((entry) => entry.path === shared && entry.kind === "prompt");
		expect(sharedSkill?.id).toBeDefined();
		expect(sharedPrompt?.id).toBeDefined();
		expect(sharedSkill?.id).not.toBe(sharedPrompt?.id);
	});

	it("does not publish an inventory when the first reload fails", async () => {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			promptsOverride: () => {
				throw new Error("failed initial reload");
			},
		});
		await expect(loader.reload()).rejects.toThrow("failed initial reload");
		expect(() => loader.getResourceInventory()).toThrow(/successful ordinary reload/i);
	});

	it("captures the final trust resolution rather than bootstrap extensions", async () => {
		const extensionDir = join(agentDir, "extensions");
		const bootstrap = join(extensionDir, "bootstrap.ts");
		mkdirSync(extensionDir);
		writeFileSync(bootstrap, "export default function() {};");
		const settingsManager = SettingsManager.inMemory();
		let factoryCalls = 0;
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [() => void factoryCalls++],
		});
		await loader.reload({
			resolveProjectTrust: async ({ extensionsResult }) => {
				expect(extensionsResult.extensions.some((extension) => extension.path === bootstrap)).toBe(true);
				expect(() => loader.getResourceInventory()).toThrow(/reload/i);
				settingsManager.setExtensionPaths(["-extensions/bootstrap.ts"]);
				return false;
			},
		});
		expect(factoryCalls).toBe(1);
		expect(loader.getResourceInventory().entries.find((entry) => entry.path === bootstrap)).toMatchObject({
			enabled: false,
		});
		expect(loader.getResourceInventory().entries.find((entry) => entry.path === "<inline:1>")).toMatchObject({
			enabled: true,
		});
	});

	it("records option-disabled resources without hiding explicit inputs", async () => {
		const extension = join(agentDir, "extensions", "auto.ts");
		const skill = join(agentDir, "skills", "auto.md");
		const prompt = join(agentDir, "prompts", "auto.md");
		const themePath = join(agentDir, "themes", "auto.json");
		for (const dir of ["extensions", "skills", "prompts", "themes"]) mkdirSync(join(agentDir, dir));
		writeFileSync(extension, "export default function() {};");
		writeFileSync(skill, "---\nname: auto\ndescription: Auto\n---\nSkill");
		writeFileSync(prompt, "Prompt");
		writeFileSync(themePath, JSON.stringify({ ...theme, name: "auto" }));
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			additionalExtensionPaths: ["builtin:forced", "builtin:blocked"],
			additionalPromptTemplatePaths: [prompt],
			disabledBuiltinExtensions: ["blocked"],
			extensionFactories: [
				{ name: "forced", builtin: true, factory: () => {} },
				{ name: "blocked", builtin: true, factory: () => {} },
				{ name: "default", builtin: true, factory: () => {} },
			],
		});
		await loader.reload();
		const { entries } = loader.getResourceInventory();
		for (const path of [extension, skill, themePath, "builtin:blocked", "builtin:default"]) {
			expect(entries.find((entry) => entry.path === path)).toMatchObject({ enabled: false });
		}
		for (const path of [prompt, "builtin:forced"]) {
			expect(entries.find((entry) => entry.path === path)).toMatchObject({ enabled: true });
		}
	});
});
