/**
 * Fork builds: upstream Pi-Bolt plus local patches, marked by fork-build.json beside pi-bolt.txt (scripts/build-pi.sh writes
 * that file). The marker says how to update the build, since upstream's release has none of the patches: `pi-bolt update` runs
 * the fork's own update command, which merges upstream and rebuilds it, and `pi-bolt compile` builds with the fork's own kit and
 * runtime. Without the marker (`--upstream`, or a build that is not a fork's) everything behaves as it does upstream.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import chalk from "chalk";
import { spawnProcess, waitForChildProcess } from "./utils/child-process.ts";

/** The marker a fork's rebuild script writes into the build's folder, beside pi-bolt.txt. */
export const FORK_BUILD_MARKER = "fork-build.json";

/** What fork-build.json says: which fork this build is, which upstream release it is built on, and how to update it. */
export interface ForkBuild {
	schema: 1;
	/** The repository the patches live in: "furbyhaxx/Pi-Bolt". */
	fork: string;
	branch: string;
	commit: string;
	/** The upstream Pi-Bolt release the patches are applied to. */
	upstreamVersion: string;
	builtAt: string;
	/** The checkout the build was made from and the update command runs in. */
	checkout: string;
	/** The command that merges upstream and rebuilds this build in place, as argv (no shell string). */
	updateCommand: string[];
	/** The compile kit and runtime `pi-bolt compile` builds this fork's Pi with. */
	kit: string;
	runtime: string;
}

/** A marker that is there but unreadable, or not a fork-build.json of a schema this build knows. */
export class ForkBuildMarkerError extends Error {
	readonly path: string;

	constructor(path: string, problem: string) {
		super(`The fork build marker ${path} is not usable: ${problem}`);
		this.name = "ForkBuildMarkerError";
		this.path = path;
	}
}

/**
 * The folder this build's marker is in: the build's own folder, which holds pi-bolt.txt (dirname(process.execPath), not the
 * installation folder around it).
 */
export function forkBuildFolder(): string {
	return dirname(process.execPath);
}

/**
 * What fork-build.json in `folder` says, or null when there is none (an ordinary upstream build). A marker that is there but
 * invalid throws: a fork build is never taken for upstream's release, which has none of its patches.
 */
export function readForkBuild(folder: string = forkBuildFolder()): ForkBuild | null {
	const path = join(folder, FORK_BUILD_MARKER);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new ForkBuildMarkerError(path, error instanceof Error ? error.message : String(error));
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new ForkBuildMarkerError(
			path,
			`it is not JSON (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ForkBuildMarkerError(path, "it is not a JSON object");
	}
	const marker = value as Record<string, unknown>;
	if (marker.schema !== 1) {
		throw new ForkBuildMarkerError(
			path,
			`its schema is ${JSON.stringify(marker.schema)}, and this build knows schema 1`,
		);
	}
	const fields = ["fork", "branch", "commit", "upstreamVersion", "builtAt", "checkout", "kit", "runtime"] as const;
	for (const field of fields) {
		const fieldValue = marker[field];
		if (typeof fieldValue !== "string" || fieldValue.trim() === "") {
			throw new ForkBuildMarkerError(path, `${field} is not a string`);
		}
	}
	const updateCommand = marker.updateCommand;
	if (
		!Array.isArray(updateCommand) ||
		updateCommand.length === 0 ||
		updateCommand.some((arg) => typeof arg !== "string" || arg === "")
	) {
		throw new ForkBuildMarkerError(path, "updateCommand is not a list of arguments");
	}
	return {
		schema: 1,
		// (The loop above checked every one of these is a non-empty string.)
		fork: marker.fork as string,
		branch: marker.branch as string,
		commit: marker.commit as string,
		upstreamVersion: marker.upstreamVersion as string,
		builtAt: marker.builtAt as string,
		checkout: marker.checkout as string,
		updateCommand: updateCommand as string[],
		kit: marker.kit as string,
		runtime: marker.runtime as string,
	};
}

function shortCommit(commit: string): string {
	return commit.slice(0, 7);
}

/**
 * How doctor and `pi-bolt --version` show a fork build: "furbyhaxx/Pi-Bolt fork/carry@f22941d (upstream 1.1.7)". Undefined for
 * a build that is not a fork's; a marker that cannot be read is shown as its problem, which doctor reports rather than fails on.
 */
export function forkBuildText(folder: string = forkBuildFolder()): string | undefined {
	try {
		const build = readForkBuild(folder);
		if (!build) return undefined;
		return `${build.fork} ${build.branch}@${shortCommit(build.commit)} (upstream ${build.upstreamVersion})`;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** One short line for the update notice of a fork build, or undefined when this build is not a fork's. */
export function forkBuildUpdateHint(folder: string = forkBuildFolder()): string | undefined {
	if (!existsSync(join(folder, FORK_BUILD_MARKER))) return undefined;
	return "pi-bolt update merges upstream and rebuilds this fork build.";
}

/**
 * Runs a fork build's update command in its checkout: it merges upstream into the fork and rebuilds this build in place. The
 * command is argv, never a shell string, and its output goes straight to the terminal. Returns its exit code, and 1 when it
 * does not start.
 */
export async function runForkBuildUpdate(build: ForkBuild): Promise<number> {
	const [command, ...args] = build.updateCommand;
	console.log(
		chalk.dim(
			`Fork build ${build.fork} ${build.branch}@${shortCommit(build.commit)}: running ${build.updateCommand.join(" ")} (it merges upstream ${build.upstreamVersion} and rebuilds; \`pi-bolt update --upstream\` installs upstream's release instead, without the fork patches)`,
		),
	);
	try {
		const child = spawnProcess(command, args, { cwd: build.checkout, stdio: "inherit" });
		return (await waitForChildProcess(child)) ?? 1;
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
		return 1;
	}
}

/**
 * The kit and runtime a compile of a fork build uses: the marker's, unless --kit and --runtime name others. A missing file
 * fails, naming it and the command that rebuilds it, because the release's own kit would build upstream's Pi without the
 * patches. Undefined when the flags are given or this build is not a fork's.
 */
export function forkBuildCompilePaths(
	given: { kit?: string; runtime?: string },
	folder: string = forkBuildFolder(),
): { kit: string; runtime: string } | undefined {
	if (given.kit || given.runtime) return undefined;
	const build = readForkBuild(folder);
	if (!build) return undefined;
	const missing = [
		["kit", build.kit],
		["runtime", build.runtime],
	].filter(([, path]) => !existsSync(path));
	if (missing.length > 0) {
		throw new Error(
			`the fork build's ${missing.map(([name, path]) => `${name} ${path}`).join(" and ")} ${missing.length === 1 ? "is" : "are"} gone: ${build.updateCommand.join(" ")} rebuilds ${missing.length === 1 ? "it" : "them"}`,
		);
	}
	return { kit: build.kit, runtime: build.runtime };
}
