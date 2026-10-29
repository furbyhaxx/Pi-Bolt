import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as PiBolt from "../src/pi-bolt.ts";
import {
	PIBOLT_INSTALL_COMMAND,
	PIBOLT_INSTALL_URL,
	PIBOLT_LATEST_RELEASE_API,
	PIBOLT_LATEST_RELEASE_URL,
	PIBOLT_RELEASE_KEY,
	PIBOLT_RELEASES_API,
	PIBOLT_RELEASES_FEED,
	PIBOLT_RELEASES_URL,
	piBoltJitSwitchCommand,
	piBoltMiseTool,
	piBoltPackageManager,
	piBoltUpdateCommand,
	piBoltUpdateEnvironment,
	piBoltVersionOfTag,
} from "../src/pi-bolt.ts";
import { PIBOLT_FORK } from "../src/pi-bolt-fork.generated.ts";
import { getLatestPiRelease } from "../src/utils/version-check.ts";

const buildState = vi.hoisted(() => ({ bolt: false }));
vi.mock("@earendil-works/pi-ai", () => ({ formatUserAgent: () => "pi-test" }));
vi.mock("../src/pi-bolt.ts", async (importOriginal) => ({
	...(await importOriginal<typeof PiBolt>()),
	get PIBOLT() {
		return buildState.bolt ? { version: "1.0.0", variant: "x64", jit: false } : undefined;
	},
}));

const root = fileURLToPath(new URL("../../../", import.meta.url));
const generator = join(root, "scripts/generate-fork-config.mjs");
const realExecPath = process.execPath;
const tempDirs: string[] = [];

function runGenerator(...args: string[]) {
	return spawnSync(realExecPath, [generator, ...args], { encoding: "utf8" });
}

function publicKey(): string {
	return generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
}

afterEach(() => {
	Object.defineProperty(process, "execPath", { value: realExecPath, configurable: true });
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	buildState.bolt = false;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("fork identity", () => {
	it("generates deterministic identity from the configured repository and signing key, and detects drift", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-bolt-fork-"));
		tempDirs.push(dir);
		const configFile = join(dir, "fork.json");
		const keyFile = join(dir, "release.pub");
		const outputFile = join(dir, "generated.ts");
		const firstKey = publicKey();
		const config = {
			repository: "first/Pi-Bolt",
			upstreamRepository: "upstream/Pi-Bolt",
			upstreamBranch: "pi-bolt",
			tagPrefix: "bolt-v",
			publicKeyFile: "release.pub",
		};
		writeFileSync(configFile, JSON.stringify(config));
		writeFileSync(keyFile, firstKey);
		const args = ["--config", configFile, "--output", outputFile];
		expect(runGenerator(...args).status).toBe(0);
		const firstOutput = readFileSync(outputFile, "utf8");
		expect(firstOutput).toContain("https://github.com/first/Pi-Bolt/releases/latest/download/install.sh");
		expect(firstOutput).toContain(JSON.stringify(firstKey));
		expect(runGenerator(...args, "--check").status).toBe(0);
		expect(runGenerator(...args).status).toBe(0);
		expect(readFileSync(outputFile, "utf8")).toBe(firstOutput);

		const secondKey = publicKey();
		writeFileSync(keyFile, secondKey);
		const stale = runGenerator(...args, "--check");
		expect(stale.status).toBe(1);
		expect(stale.stderr).toContain("out of date");
		expect(readFileSync(outputFile, "utf8")).toBe(firstOutput);
		expect(runGenerator(...args).status).toBe(0);
		expect(readFileSync(outputFile, "utf8")).toContain(JSON.stringify(secondKey));
		writeFileSync(configFile, JSON.stringify({ ...config, repository: "second/Pi-Bolt", tagPrefix: "fork-v" }));
		expect(runGenerator(...args, "--check").status).toBe(1);
		expect(runGenerator(...args).status).toBe(0);
		const secondOutput = readFileSync(outputFile, "utf8");
		expect(secondOutput).toContain("https://github.com/second/Pi-Bolt/releases/download");
		expect(secondOutput).toContain(JSON.stringify(secondKey));
		expect(secondOutput).not.toContain(JSON.stringify(firstKey));
		const json = runGenerator("--config", configFile, "--json");
		expect(json.status).toBe(0);
		expect(JSON.parse(json.stdout)).toMatchObject({
			repository: "second/Pi-Bolt",
			upstreamRepository: "upstream/Pi-Bolt",
			upstreamBranch: "pi-bolt",
			tagPrefix: "fork-v",
			releasePublicKey: secondKey,
			releaseDownloadBase: "https://github.com/second/Pi-Bolt/releases/download",
		});
		expect(runGenerator(...args, "--check").status).toBe(0);
	});

	it("rejects a private key rather than embedding it in the generated identity", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-bolt-fork-key-"));
		tempDirs.push(dir);
		const configFile = join(dir, "fork.json");
		const keyFile = join(dir, "release.pub");
		const outputFile = join(dir, "generated.ts");
		const privateKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
		writeFileSync(
			configFile,
			JSON.stringify({
				repository: "fork/Pi-Bolt",
				upstreamRepository: "upstream/Pi-Bolt",
				upstreamBranch: "pi-bolt",
				tagPrefix: "bolt-v",
				publicKeyFile: "release.pub",
			}),
		);
		writeFileSync(keyFile, privateKey);
		const result = runGenerator("--config", configFile, "--output", outputFile);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Ed25519 public key");
		expect(existsSync(outputFile)).toBe(false);
	});

	it("uses the fork's release, API, installer, compile and signing identity", () => {
		const releases = "https://github.com/furbyhaxx/Pi-Bolt/releases";
		expect(PIBOLT_FORK.repository).toBe("furbyhaxx/Pi-Bolt");
		expect(PIBOLT_FORK.upstreamRepository).toBe("opensec-git/Pi-Bolt");
		expect(PIBOLT_FORK.upstreamBranch).toBe("pi-bolt");
		expect(PIBOLT_RELEASES_URL).toBe(releases);
		expect(PIBOLT_LATEST_RELEASE_URL).toBe(`${releases}/latest`);
		expect(PIBOLT_RELEASES_FEED).toBe(`${releases}.atom`);
		expect(PIBOLT_LATEST_RELEASE_API).toBe("https://api.github.com/repos/furbyhaxx/Pi-Bolt/releases/latest");
		expect(PIBOLT_RELEASES_API).toBe("https://api.github.com/repos/furbyhaxx/Pi-Bolt/releases?per_page=30");
		expect(PIBOLT_INSTALL_URL).toBe(
			`${releases}/latest/download/${process.platform === "win32" ? "install.ps1" : "install.sh"}`,
		);
		expect(`${PIBOLT_FORK.releaseDownloadBase}/${PIBOLT_FORK.tagPrefix}1.2.3`).toBe(
			`${releases}/download/bolt-v1.2.3`,
		);
		expect(PIBOLT_RELEASE_KEY).toBe(readFileSync(join(root, "keys/release.pub"), "utf8"));
		expect(piBoltVersionOfTag(" bolt-v1.2.3 ")).toBe("1.2.3");
		expect(piBoltVersionOfTag("v1.2.3")).toBeUndefined();
		vi.stubEnv("PIBOLT_NPM_REGISTRY", "https://registry.example.test");
		const env = piBoltUpdateEnvironment("1.2.3");
		expect(env.PIBOLT_VERSION).toBe(`${PIBOLT_FORK.tagPrefix}1.2.3`);
		expect(env.PIBOLT_NPM_REGISTRY).toBeUndefined();
		expect(piBoltUpdateCommand("npm")).toBe(PIBOLT_INSTALL_COMMAND);
	});

	it("checks the fork's releases while stock Pi continues to use pi.dev", async () => {
		vi.stubEnv("PI_OFFLINE", "");
		vi.stubEnv("PIBOLT_CHANNEL", "stable");
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url === "https://pi.dev/api/latest-version") return Response.json({ version: "2.0.0" });
			if (url === PIBOLT_FORK.latestReleaseUrl) {
				return new Response(null, {
					status: 302,
					headers: { location: `${PIBOLT_FORK.releasesUrl}/tag/${PIBOLT_FORK.tagPrefix}2.0.0` },
				});
			}
			throw new Error(`unexpected release request: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		expect(await getLatestPiRelease("1.0.0")).toEqual({ version: "2.0.0" });
		buildState.bolt = true;
		expect(await getLatestPiRelease("1.0.0")).toEqual({ version: "2.0.0" });
		expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
			"https://pi.dev/api/latest-version",
			"https://github.com/furbyhaxx/Pi-Bolt/releases/latest",
		]);
	});

	it("routes manager migration and JIT installation to the fork without updating manager-owned files", () => {
		const forkTool = "github:furbyhaxx/Pi-Bolt";
		const forkFolder = "/home/me/.local/share/mise/installs/github-furbyhaxx-pi-bolt/1.0.0/pi";
		const upstreamFolder = "/home/me/.local/share/mise/installs/github-opensec-git-pi-bolt/1.0.0/pi";
		const shorthandFolder = "/home/me/.local/share/mise/installs/pi-bolt/1.0.0/pi";
		expect(piBoltMiseTool(forkFolder)).toBe(forkTool);
		expect(piBoltMiseTool(upstreamFolder)).toBe("github:opensec-git/Pi-Bolt");
		expect(piBoltMiseTool(shorthandFolder)).toBe("pi-bolt");
		for (const path of [upstreamFolder, shorthandFolder]) {
			Object.defineProperty(process, "execPath", { value: path, configurable: true });
			expect(piBoltPackageManager("mise")?.name).toContain("unsupported");
			expect(piBoltPackageManager("mise")?.update).toBe(PIBOLT_INSTALL_COMMAND);
		}
		Object.defineProperty(process, "execPath", { value: forkFolder, configurable: true });
		expect(piBoltPackageManager("mise")?.update).toBe(`mise upgrade --bump ${forkTool}`);
		for (const method of ["homebrew", "scoop"] as const) {
			const manager = piBoltPackageManager(method);
			expect(manager?.source).toContain("unsupported");
			expect(manager?.update).toContain("https://github.com/furbyhaxx/Pi-Bolt/releases/latest/download/");
			expect(manager?.update).not.toMatch(/(?:brew upgrade|scoop update)/);
		}
		for (const method of ["installer", "npm", "homebrew", "scoop", "mise"] as const) {
			for (const platform of ["darwin", "win32"] as const) {
				const command = piBoltJitSwitchCommand(method, platform, "x64-jit");
				expect(command).toContain("https://github.com/furbyhaxx/Pi-Bolt/releases/latest/download/");
				expect(command).not.toContain("https://pi-bolt.opensec.in");
				expect(command).not.toContain("npm install");
			}
		}
	});
});
