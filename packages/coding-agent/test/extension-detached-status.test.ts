import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CompiledExtension,
	compiledExtensionList,
	extensionFingerprint,
	setCompiledExtensions,
} from "../src/core/extensions/compiled.ts";
import { clearExtensionCache, loadExtensions, loadExtensionsCached } from "../src/core/extensions/loader.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";

vi.mock("../src/pi-bolt.ts", async (importOriginal) => ({
	...(await importOriginal<object>()),
	PIBOLT: { version: "1.0.0", variant: "arm64", jit: true },
}));

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-detached-extension-"));
	clearExtensionCache();
});

afterEach(() => {
	setCompiledExtensions([]);
	clearExtensionCache();
	rmSync(dir, { recursive: true, force: true });
});

function compiledIn(entry: string, factory: ExtensionFactory): CompiledExtension {
	const source = { name: "test", entry, root: dir, scope: "file" as const };
	const fingerprint = extensionFingerprint(source);
	if (!fingerprint) throw new Error(`No fingerprint for ${entry}`);
	return { ...source, fingerprint, factory, loaded: false };
}

function writeCommandExtension(entry: string, command: string): void {
	writeFileSync(
		entry,
		`export default (pi) => pi.registerCommand(${JSON.stringify(command)}, { handler: async () => {} });\n`,
	);
}

describe("detached extension status", () => {
	it("uses the compiled factory without marking it loaded, while default loads update status", async () => {
		const entry = join(dir, "compiled.ts");
		writeCommandExtension(entry, "filesystem");
		const factory = vi.fn<ExtensionFactory>((pi) => pi.registerCommand("compiled", { handler: async () => {} }));
		const extension = compiledIn(entry, factory);
		setCompiledExtensions([extension]);
		const before = { ...extension };

		const detached = await loadExtensions([entry], dir, undefined, undefined, { compiledStatus: "detached" });
		expect(detached.errors).toEqual([]);
		expect(detached.warnings).toEqual([]);
		expect(detached.extensions.map((loaded) => [...loaded.commands.keys()])).toEqual([["compiled"]]);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(compiledExtensionList()).toStrictEqual([before]);
		expect(compiledExtensionList()[0]).toBe(extension);
		expect(extension.failed).toBeUndefined();

		const active = await loadExtensions([entry], dir);
		expect(active.errors).toEqual([]);
		expect(active.extensions.map((loaded) => [...loaded.commands.keys()])).toEqual([["compiled"]]);
		expect(factory).toHaveBeenCalledTimes(2);
		expect(extension.loaded).toBe(true);
		expect(extension.failed).toBeUndefined();
	});

	it("keeps compiled failure local while preserving fallback warnings and active failure behavior", async () => {
		const entry = join(dir, "fallback.ts");
		writeCommandExtension(entry, "filesystem");
		const factory = vi.fn<ExtensionFactory>((pi) => {
			pi.registerCommand("failed-compiled", { handler: async () => {} });
			throw new Error("compiled failed\nmore details");
		});
		const extension = { ...compiledIn(entry, factory), loaded: true };
		setCompiledExtensions([extension]);
		const before = { ...extension };
		const warning = {
			path: entry,
			warning:
				"it failed compiled in (compiled failed), so it was loaded from its files: `pi-bolt compile` builds without it",
		};

		for (let attempt = 0; attempt < 2; attempt++) {
			const detached = await loadExtensions([entry], dir, undefined, undefined, { compiledStatus: "detached" });
			expect(detached.errors).toEqual([]);
			expect(detached.extensions.map((loaded) => [...loaded.commands.keys()])).toEqual([["filesystem"]]);
			expect(detached.warnings).toEqual([warning]);
			expect(compiledExtensionList()).toStrictEqual([before]);
			expect(extension.failed).toBeUndefined();
		}
		expect(factory).toHaveBeenCalledTimes(2);

		const active = await loadExtensions([entry], dir);
		expect(active.errors).toEqual([]);
		expect(active.extensions.map((loaded) => [...loaded.commands.keys()])).toEqual([["filesystem"]]);
		expect(active.warnings).toEqual([warning]);
		expect(extension.failed).toBe("compiled failed");
		expect(extension.loaded).toBe(true);
		expect(factory).toHaveBeenCalledTimes(3);

		const subsequent = await loadExtensions([entry], dir, undefined, undefined, { compiledStatus: "detached" });
		expect(subsequent.errors).toEqual([]);
		expect(subsequent.extensions.map((loaded) => [...loaded.commands.keys()])).toEqual([["filesystem"]]);
		expect(subsequent.warnings).toEqual([warning]);
		expect(factory).toHaveBeenCalledTimes(3);
		expect(extension.failed).toBe("compiled failed");
	});

	it("keeps existing status and the changed-file warning when the compiled source changes", async () => {
		const entry = join(dir, "changed.ts");
		writeCommandExtension(entry, "old");
		const factory = vi.fn<ExtensionFactory>(() => {});
		const extension = { ...compiledIn(entry, factory), loaded: true, failed: "earlier failure" };
		setCompiledExtensions([extension]);
		const before = { ...extension };
		writeCommandExtension(entry, "changed-filesystem");

		const detached = await loadExtensions([entry], dir, undefined, undefined, { compiledStatus: "detached" });
		expect(detached.errors).toEqual([]);
		expect(detached.extensions.map((loaded) => [...loaded.commands.keys()])).toEqual([["changed-filesystem"]]);
		expect(detached.warnings).toEqual([
			{
				path: entry,
				warning:
					"changed since it was compiled in, so it was loaded from its files: run `pi-bolt compile` to compile it in again",
			},
		]);
		expect(factory).not.toHaveBeenCalled();
		expect(compiledExtensionList()).toStrictEqual([before]);
	});

	it("does not mark a compiled failure when filesystem fallback also fails", async () => {
		const entry = join(dir, "broken.ts");
		writeFileSync(entry, 'throw new Error("filesystem failed");\n');
		const extension = compiledIn(entry, () => {
			throw new Error("compiled failed");
		});
		setCompiledExtensions([extension]);

		const detached = await loadExtensions([entry], dir, undefined, undefined, { compiledStatus: "detached" });
		expect(detached.extensions).toEqual([]);
		expect(detached.errors[0]?.error).toContain("filesystem failed");
		expect(detached.warnings).toEqual([]);
		expect(extension.loaded).toBe(false);
		expect(extension.failed).toBeUndefined();
	});

	it("loads revised files without using or clearing the active factory cache", async () => {
		const entry = join(dir, "cached.ts");
		const activeCwd = join(dir, "active");
		const candidateCwd = join(dir, "candidate");
		mkdirSync(activeCwd);
		mkdirSync(candidateCwd);
		writeCommandExtension(entry, "original");
		utimesSync(entry, 1_000_000, 1_000_000);
		const first = await loadExtensionsCached([entry], activeCwd);
		expect(first.errors).toEqual([]);
		expect(first.extensions.map((loaded) => [...loaded.commands.keys()])).toEqual([["original"]]);

		writeCommandExtension(entry, "revised-edition");
		utimesSync(entry, 2_000_000, 2_000_000);
		for (const cwd of [candidateCwd, activeCwd]) {
			const detached = await loadExtensions([entry], cwd, undefined, undefined, { compiledStatus: "detached" });
			expect(detached.errors).toEqual([]);
			expect(detached.extensions.map((loaded) => [...loaded.commands.keys()])).toEqual([["revised-edition"]]);
		}
		const again = await loadExtensionsCached([entry], activeCwd);
		expect(again.errors).toEqual([]);
		expect(again.extensions.map((loaded) => [...loaded.commands.keys()])).toEqual([["original"]]);
	});
});
