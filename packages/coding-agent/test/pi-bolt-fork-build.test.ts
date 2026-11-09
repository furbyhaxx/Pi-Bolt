import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runDoctor } from "../src/cli/doctor.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";
import type * as PiBolt from "../src/pi-bolt.ts";
import { runPiBoltCompile } from "../src/pi-bolt-compile.ts";
import {
	FORK_BUILD_MARKER,
	type ForkBuild,
	ForkBuildMarkerError,
	forkBuildCompilePaths,
	forkBuildText,
	forkBuildUpdateHint,
	readForkBuild,
} from "../src/pi-bolt-fork-build.ts";
import type * as Installer from "../src/pi-bolt-installer.ts";
import { fetchReleaseInstaller, runReleaseInstaller } from "../src/pi-bolt-installer.ts";
import type * as VersionCheck from "../src/utils/version-check.ts";
import { getLatestPiRelease } from "../src/utils/version-check.ts";

// A Pi-Bolt build (scripts/build-pi.sh defines PIBOLT_BUILD); the tests run as Pi otherwise. (vi.mock runs before the imports.)
vi.mock("../src/pi-bolt.ts", async (importOriginal) => ({
	...(await importOriginal<typeof PiBolt>()),
	PIBOLT: { version: "1.1.7", variant: "x64", jit: false },
}));
// The next upstream release, without going online.
vi.mock("../src/utils/version-check.ts", async (importOriginal) => ({
	...(await importOriginal<typeof VersionCheck>()),
	getLatestPiRelease: vi.fn(async () => ({ version: "1.1.8" })),
}));
// Upstream's release installer: an update that installs the release goes through it.
vi.mock("../src/pi-bolt-installer.ts", async (importOriginal) => ({
	...(await importOriginal<typeof Installer>()),
	fetchReleaseInstaller: vi.fn(async () => ({ name: "install.sh" })),
	runReleaseInstaller: vi.fn(async () => 0),
}));

const realExecPath = process.execPath;
const realChannel = process.env.PIBOLT_CHANNEL;
let dir: string;

function runningFrom(execPath: string): void {
	Object.defineProperty(process, "execPath", { value: execPath, configurable: true });
}

/** The marker a fork's rebuild script writes: `overrides` for what a test changes. */
function marker(folder: string, overrides: Partial<ForkBuild> = {}): ForkBuild {
	const value: ForkBuild = {
		schema: 1,
		fork: "furbyhaxx/Pi-Bolt",
		branch: "fork/carry",
		commit: "f22941d563ab",
		upstreamVersion: "1.1.7",
		builtAt: "2026-11-09T09:00:00.000Z",
		checkout: join(dir, "checkout"),
		updateCommand: [join(dir, "update.sh")],
		kit: join(dir, "out", "kit", "pi-bolt-kit-linux-x64.tar.gz"),
		runtime: join(dir, "work", "runtime", "bun"),
		...overrides,
	};
	writeFileSync(join(folder, FORK_BUILD_MARKER), `${JSON.stringify(value, null, "\t")}\n`);
	return value;
}

/** An installation of the installer's: ~/.pi-bolt/pi-bolt-linux-x64, whose `pi` says it is Pi-Bolt `version`. */
function installation(version = "1.1.7"): { install: string; build: string } {
	const install = join(dir, ".pi-bolt");
	const build = join(install, "pi-bolt-linux-x64");
	mkdirSync(build, { recursive: true });
	writeFileSync(join(build, "pi-bolt.txt"), `Pi-Bolt ${version} (Pi 1.4.3), linux-x64, JIT off, built 2026-11-09\n`);
	writeFileSync(join(build, "pi"), `#!/bin/sh\necho "1.4.3 (Pi-Bolt ${version}, linux-x64, JIT off)"\n`);
	chmodSync(join(build, "pi"), 0o755);
	runningFrom(join(build, "pi"));
	return { install, build };
}

/** A script, as a fork's rebuild script is: it writes its arguments and working folder beside itself, then exits `code`. */
function updateScript(code: number): string {
	const script = join(dir, "update.sh");
	writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "$0.argv"\npwd > "$0.cwd"\nexit ${code}\n`);
	chmodSync(script, 0o755);
	return script;
}

const said = (spy: { mock: { calls: unknown[][] } }): string => spy.mock.calls.flat().join("\n");

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pibolt-fork-"));
	mkdirSync(join(dir, "checkout"), { recursive: true });
	delete process.env.PIBOLT_CHANNEL;
	vi.stubEnv("PIBOLT_NPM", "");
	vi.stubEnv(ENV_AGENT_DIR, join(dir, "agent"));
});

afterEach(() => {
	runningFrom(realExecPath);
	if (realChannel === undefined) delete process.env.PIBOLT_CHANNEL;
	else process.env.PIBOLT_CHANNEL = realChannel;
	process.exitCode = undefined;
	vi.unstubAllEnvs();
	vi.clearAllMocks();
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

describe("the fork build marker", () => {
	test("a build without one is an ordinary upstream build", () => {
		expect(readForkBuild(dir)).toBeNull();
		expect(forkBuildText(dir)).toBeUndefined();
		expect(forkBuildUpdateHint(dir)).toBeUndefined();
	});

	test("says which fork the build is, on which upstream release", () => {
		const value = marker(dir, { updateCommand: [join(dir, "scripts", "fork", "update.sh"), "--keep"] });
		expect(readForkBuild(dir)).toEqual(value);
		expect(forkBuildText(dir)).toBe("furbyhaxx/Pi-Bolt fork/carry@f22941d (upstream 1.1.7)");
		expect(forkBuildUpdateHint(dir)).toBe("pi-bolt update merges upstream and rebuilds this fork build.");
	});

	test("a marker that is not one is a typed error, never an upstream build", () => {
		const path = join(dir, FORK_BUILD_MARKER);
		writeFileSync(path, "{ not json");
		expect(() => readForkBuild(dir)).toThrow(ForkBuildMarkerError);
		expect(() => readForkBuild(dir)).toThrow(/not usable: it is not JSON/);
		expect(forkBuildText(dir)).toContain(path);

		marker(dir);
		writeFileSync(path, JSON.stringify({ ...marker(dir), schema: 2 }));
		let error: unknown;
		try {
			readForkBuild(dir);
		} catch (thrown) {
			error = thrown;
		}
		expect(error).toBeInstanceOf(ForkBuildMarkerError);
		expect((error as ForkBuildMarkerError).path).toBe(path);
		expect((error as Error).message).toContain("its schema is 2");

		writeFileSync(path, JSON.stringify({ ...marker(dir), updateCommand: [] }));
		expect(() => readForkBuild(dir)).toThrow(/updateCommand is not a list of arguments/);
		writeFileSync(path, JSON.stringify({ ...marker(dir), kit: 42 }));
		expect(() => readForkBuild(dir)).toThrow(/kit is not a string/);
	});
});

describe.skipIf(process.platform === "win32")("pi-bolt update of a fork build", () => {
	test("runs the marker's update command with its arguments, and its exit code", async () => {
		const { build } = installation();
		const script = updateScript(3);
		marker(build, { updateCommand: [script, "merge", "a b"] });
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		expect(await handlePackageCommand(["update"])).toBe(true);

		expect(readFileSync(`${script}.argv`, "utf8")).toBe("merge\na b\n");
		expect(readFileSync(`${script}.cwd`, "utf8").trim()).toBe(realpathSync(join(dir, "checkout")));
		expect(process.exitCode).toBe(3);
		// (The line first: what runs, and that --upstream takes upstream's release instead.)
		expect(said(log)).toContain(`Fork build furbyhaxx/Pi-Bolt fork/carry@f22941d: running ${script} merge a b`);
		expect(said(log)).toContain("`pi-bolt update --upstream` installs upstream's release instead");
		// (Upstream's release is not fetched, and its installer does not run.)
		expect(vi.mocked(getLatestPiRelease)).not.toHaveBeenCalled();
		expect(vi.mocked(fetchReleaseInstaller)).not.toHaveBeenCalled();
		expect(vi.mocked(runReleaseInstaller)).not.toHaveBeenCalled();
	});

	test("--upstream leaves the fork build for upstream's release, and says the patches are lost", async () => {
		const { build } = installation("1.1.8");
		const script = updateScript(0);
		marker(build, { updateCommand: [script] });
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(await handlePackageCommand(["update", "--upstream"])).toBe(true);

		expect(vi.mocked(fetchReleaseInstaller)).toHaveBeenCalledWith("1.1.8");
		expect(vi.mocked(runReleaseInstaller)).toHaveBeenCalled();
		expect(said(log)).toContain("Updated Pi-Bolt from 1.1.7 to 1.1.8");
		expect(said(log)).not.toContain("Fork build furbyhaxx");
		expect(said(error)).toContain("--upstream installs upstream's release over a fork build");
		expect(() => readFileSync(`${script}.argv`, "utf8")).toThrow();
	});

	test("without a marker the release installer runs as before", async () => {
		installation("1.1.8");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		expect(await handlePackageCommand(["update"])).toBe(true);

		expect(vi.mocked(getLatestPiRelease)).toHaveBeenCalled();
		expect(vi.mocked(fetchReleaseInstaller)).toHaveBeenCalledWith("1.1.8");
		expect(said(log)).toContain("Updated Pi-Bolt from 1.1.7 to 1.1.8");
		expect(said(log)).not.toContain("Fork build");
	});

	test("a marker that cannot be read stops the update instead of installing upstream's release", async () => {
		const { build } = installation("1.1.8");
		writeFileSync(join(build, FORK_BUILD_MARKER), JSON.stringify({ schema: 7 }));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(await handlePackageCommand(["update"])).toBe(true);

		expect(process.exitCode).toBe(1);
		expect(said(error)).toContain("The fork build marker");
		expect(said(error)).toContain("its schema is 7");
		expect(vi.mocked(fetchReleaseInstaller)).not.toHaveBeenCalled();
	});
});

describe("pi-bolt compile of a fork build", () => {
	test("builds with the marker's kit and runtime, unless --kit and --runtime name others", () => {
		const { build } = installation();
		const value = marker(build);
		mkdirSync(join(dir, "out", "kit"), { recursive: true });
		mkdirSync(join(dir, "work", "runtime"), { recursive: true });
		writeFileSync(value.kit, "the kit");
		writeFileSync(value.runtime, "the runtime");

		expect(forkBuildCompilePaths({})).toEqual({ kit: value.kit, runtime: value.runtime });
		// (Explicit flags win, and the marker's files are then not needed.)
		expect(forkBuildCompilePaths({ kit: "/elsewhere/kit.tar.gz", runtime: "/elsewhere/bun" })).toBeUndefined();
		expect(forkBuildCompilePaths({ kit: "/elsewhere/kit.tar.gz" })).toBeUndefined();
	});

	test("a build that is not a fork's keeps the release's kit", () => {
		installation();
		expect(forkBuildCompilePaths({})).toBeUndefined();
	});

	test.skipIf(process.platform === "win32")(
		"a kit that is gone fails before anything is built, naming it and the command that rebuilds it",
		async () => {
			const { build } = installation();
			const script = join(dir, "scripts", "fork", "update.sh");
			const value = marker(build, { updateCommand: [script] });
			const error = vi.spyOn(console, "error").mockImplementation(() => {});

			expect(await runPiBoltCompile([], async () => true)).toBe(1);

			const message = said(error);
			expect(message).toContain(`kit ${value.kit}`);
			expect(message).toContain("are gone");
			expect(message).toContain(`${script} rebuilds them`);
		},
	);
});

describe.skipIf(process.platform === "win32")("doctor and the update notice", () => {
	test("doctor shows the fork build", async () => {
		const home = join(dir, "home");
		const agentDir = join(home, ".pi", "agent");
		const bin = join(home, "bin");
		for (const folder of [agentDir, bin]) mkdirSync(folder, { recursive: true });
		const { build } = installation();
		marker(build);
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("XDG_CONFIG_HOME", "");
		vi.stubEnv("PATH", bin);
		let output = "";
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			output += String(chunk);
			return true;
		});

		expect(await runDoctor(["--offline"], { cwd: home, agentDir, extensionFactories: [] })).toBe(0);

		expect(output).toMatch(/ {2}fork build +furbyhaxx\/Pi-Bolt fork\/carry@f22941d \(upstream 1\.1\.7\)/);
	});

	test("doctor shows what is wrong with a marker it cannot read", async () => {
		const home = join(dir, "home");
		const agentDir = join(home, ".pi", "agent");
		const bin = join(home, "bin");
		for (const folder of [agentDir, bin]) mkdirSync(folder, { recursive: true });
		const { build } = installation();
		writeFileSync(join(build, FORK_BUILD_MARKER), "{}");
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("XDG_CONFIG_HOME", "");
		vi.stubEnv("PATH", bin);
		let output = "";
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			output += String(chunk);
			return true;
		});

		expect(await runDoctor(["--offline"], { cwd: home, agentDir, extensionFactories: [] })).toBe(0);

		expect(output).toContain("fork build");
		expect(output).toContain("its schema is undefined");
	});
});
