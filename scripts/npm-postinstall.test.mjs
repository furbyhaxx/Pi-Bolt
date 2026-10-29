// Tests of the pi-bolt npm package's install script (npm/install.cjs), with a fake release signed with a key made here:
// no network, no real release key.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const npmDir = fileURLToPath(new URL("../npm/", import.meta.url));
const root = fileURLToPath(new URL("../", import.meta.url));
const install = require(join(npmDir, "install.cjs"));
const VERSION = JSON.parse(readFileSync(join(npmDir, "package.json"), "utf8")).version;
const PLACEHOLDER = readFileSync(join(npmDir, "bin", "pi-bolt.exe"));
const WINDOWS_10_1809 = "10.0.17763";

// --- Archives, made as the release makes them -------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(data) {
	let c = 0xffffffff;
	for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** A .zip of `entries` ({ name, data }): deflated, as .NET's ZipFile makes them; a name ending in / is a folder. */
function makeZip(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const { name, data = Buffer.alloc(0), method = name.endsWith("/") ? 0 : 8 } of entries) {
		const nameBytes = Buffer.from(name, "utf8");
		const body = method === 8 ? zlib.deflateRawSync(data) : data;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x800, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc32(data), 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x800, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(crc32(data), 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, nameBytes, body);
		centrals.push(central, nameBytes);
		offset += local.length + nameBytes.length + body.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

// --- A release ----------------------------------------------------------------------------------------------------------

function newKey() {
	const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
	return { privateKey, key: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
}

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const EXE = Buffer.from("MZ the new pi-bolt.exe");

function buildZip(variant = "x64", extra = []) {
	const top = `pi-bolt-win32-${variant}`;
	return makeZip([
		{ name: `${top}/pi-bolt.exe`, data: EXE },
		{ name: `${top}/pi-bolt.txt`, data: Buffer.from(`Pi-Bolt ${VERSION} (Pi 1.1.0), win32-${variant}, JIT off\n`) },
		{ name: `${top}/package.json`, data: Buffer.from('{"name":"pi"}\n') },
		{ name: `${top}/theme/` },
		{ name: `${top}/theme/dark.json`, data: Buffer.from("{}\n") },
		{ name: `${top}/native/win32/prebuilds/win32-x64/win32-platform.node`, data: crypto.randomBytes(5000) },
		...extra,
	]);
}

/**
 * The files of a release (as served from GitHub) and of its npm packages: `signer` signs the checksums (none: unsigned),
 * `sumsVersion` is the version the checksums say.
 */
function makeRelease({ signer, sumsVersion = VERSION, zips = { x64: buildZip() }, firstLine } = {}) {
	const lines = [firstLine ?? `# pi-bolt ${sumsVersion}`];
	const files = {};
	for (const [variant, zip] of Object.entries(zips)) {
		files[`pi-bolt-win32-${variant}.zip`] = zip;
		lines.push(`${sha256(zip)}  pi-bolt-win32-${variant}.zip`);
	}
	files.SHA256SUMS = Buffer.from(`${lines.join("\n")}\n`);
	if (signer) files["SHA256SUMS.sig"] = crypto.sign(null, files.SHA256SUMS, signer.privateKey);
	return files;
}

const fork = JSON.parse(readFileSync(join(root, "fork.json"), "utf8"));
const GITHUB = `https://github.com/${fork.repository}/releases/download/${fork.tagPrefix}${VERSION}`;
const REGISTRY = "https://registry.npmjs.org";
const npmUrl = (variant = "x64") => `${REGISTRY}/@kushalkhemka/pi-bolt-win32-${variant}/-/pi-bolt-win32-${variant}-${VERSION}.tgz`;

/** A fetch that serves `routes` (URL -> bytes) and records what was asked for. */
function fakeFetch(routes) {
	const asked = [];
	const fetch = async (url) => {
		asked.push(url);
		const body = routes[url];
		return body ? new Response(body) : new Response(null, { status: 404 });
	};
	return { fetch, asked };
}

function githubRoutes(release, base = GITHUB) {
	return Object.fromEntries(Object.entries(release).map(([name, data]) => [`${base}/${name}`, data]));
}

/** A package folder as npm leaves it before the install script runs. */
function makePackage(t) {
	const dir = mkdtempSync(join(tmpdir(), "pi-bolt-npm-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(join(dir, "bin"));
	writeFileSync(join(dir, "bin", "pi-bolt.exe"), PLACEHOLDER);
	writeFileSync(join(dir, "bin", "pi-bolt"), readFileSync(join(npmDir, "bin", "pi-bolt")));
	writeFileSync(join(dir, "package.json"), readFileSync(join(npmDir, "package.json")));
	return dir;
}

function run(pkgDir, { fetch, key, env = {}, runsVersion = () => true, hasAvx2 = () => true }) {
	const log = [];
	const promise = install.installWindows({
		pkgDir,
		version: VERSION,
		// An x64 machine unless a test says otherwise (on an ARM host process.arch would be arm64).
		env: { PROCESSOR_ARCHITECTURE: "AMD64", ...env },
		fetch,
		key,
		runsVersion,
		hasAvx2,
		release: WINDOWS_10_1809,
		log: (line) => log.push(line),
	});
	return { promise, log };
}

function assertPlaceholder(pkgDir) {
	assert.deepEqual(readFileSync(join(pkgDir, "bin", "pi-bolt.exe")), PLACEHOLDER);
	assert.deepEqual(readdirSync(pkgDir).sort(), ["bin", "package.json"], "nothing is left behind");
}

// --- The package --------------------------------------------------------------------------------------------------------

test("the package: bin/pi-bolt.exe on every platform, a placeholder with no #! line, and the install script", () => {
	const pkg = JSON.parse(readFileSync(join(npmDir, "package.json"), "utf8"));
	assert.deepEqual(pkg.bin, { "pi-bolt": "bin/pi-bolt.exe" });
	assert.equal(pkg.scripts.postinstall, "node install.cjs");
	for (const file of ["bin/pi-bolt", "bin/pi-bolt.exe", "install.cjs", "install.sh"]) assert.ok(pkg.files.includes(file), file);
	assert.ok(pkg.os.includes("win32"));
	assert.notEqual(PLACEHOLDER.toString("latin1", 0, 2), "#!", "a #! line would make npm's Windows commands start it with sh");
	assert.ok(!PLACEHOLDER.includes("\r"), "LF line ends");
	assert.ok(readFileSync(join(npmDir, "bin", "pi-bolt"), "latin1").startsWith("#!/bin/sh\n"));
	assert.equal(pkg.dependencies, undefined);
});

test("the generated release keys agree in PEM, SPKI and OpenSSH form", () => {
	const pemFile = join(root, fork.publicKeyFile);
	const pem = readFileSync(pemFile, "utf8");
	const spki = crypto.createPublicKey(pem).export({ format: "der", type: "spki" }).toString("base64");
	const ssh = spawnSync(process.execPath, [join(root, "scripts/lib/sshsig.mjs"), "pubkey", pemFile], { encoding: "utf8" });
	assert.equal(ssh.status, 0, ssh.stderr);
	assert.equal(install.RELEASE_KEY, spki);
	assert.ok(readFileSync(join(root, "install.ps1"), "utf8").includes(`$PiBoltReleaseKey = '${spki}'`));
	const sh = readFileSync(join(root, "install.sh"), "utf8");
	assert.ok(sh.includes(`RELEASE_KEY="${pem.trimEnd()}"`));
	assert.ok(sh.includes(`RELEASE_SSH_KEY="${ssh.stdout.trim()}"`));
});

function forkFixture(t) {
	const dir = mkdtempSync(join(tmpdir(), "pi-bolt-fork-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	for (const file of ["scripts/generate-fork-config.mjs", "scripts/lib/sshsig.mjs", "install.sh", "install.ps1", "npm/install.cjs", "packages/coding-agent/src/pi-bolt-fork.generated.ts"]) {
		const target = join(dir, file);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(join(root, file), target);
	}
	const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
	const config = { ...fork, repository: "test-owner/Fork.Project", tagPrefix: "rel.v-", publicKeyFile: "release.pub" };
	writeFileSync(join(dir, "fork.json"), JSON.stringify(config));
	writeFileSync(join(dir, "release.pub"), publicKey.export({ type: "spki", format: "pem" }));
	return { dir, config, publicKey, privateKey };
}

function generate(dir, ...args) {
	return spawnSync(process.execPath, [join(dir, "scripts/generate-fork-config.mjs"), ...args], { encoding: "utf8" });
}

test("generator stamps and checks standalone identity while custom paths stay isolated", (t) => {
	const { dir, config, publicKey } = forkFixture(t);
	const files = ["install.sh", "install.ps1", "npm/install.cjs", "packages/coding-agent/src/pi-bolt-fork.generated.ts"];
	const before = files.map((file) => readFileSync(join(dir, file), "utf8"));
	const custom = join(dir, "custom.ts");
	let result = generate(dir, "--config", join(dir, "fork.json"), "--output", custom);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(files.map((file) => readFileSync(join(dir, file), "utf8")), before);
	assert.equal(generate(dir, "--config", join(dir, "fork.json"), "--output", custom, "--check").status, 0);
	result = generate(dir, "--config", join(dir, "fork.json"), "--json");
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).repository, config.repository);
	assert.equal(generate(dir, "--check").status, 1);
	result = generate(dir);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(generate(dir, "--check").status, 0);
	const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
	const ssh = spawnSync(process.execPath, [join(dir, "scripts/lib/sshsig.mjs"), "pubkey", join(dir, "release.pub")], { encoding: "utf8" });
	assert.equal(ssh.status, 0, ssh.stderr);
	const sh = readFileSync(join(dir, "install.sh"), "utf8");
	const ps = readFileSync(join(dir, "install.ps1"), "utf8");
	const cjs = readFileSync(join(dir, "npm/install.cjs"), "utf8");
	assert.ok(sh.includes(`RELEASE_SSH_KEY="${ssh.stdout.trim()}"`));
	assert.ok(sh.includes(`REPO="https://github.com/${config.repository}"`));
	assert.ok(sh.includes(`API="https://api.github.com/repos/${config.repository}"`));
	assert.ok(sh.includes(`TAG_PREFIX="${config.tagPrefix}"`));
	assert.ok(sh.includes(`RELEASE_KEY="${publicKey.export({ type: "spki", format: "pem" }).trimEnd()}"`));
	assert.ok(ps.includes(`$PiBoltReleaseKey = '${spki}'`));
	assert.ok(ps.includes(`$PiBoltRepo = 'https://github.com/${config.repository}'`));
	assert.ok(ps.includes(`$PiBoltApi = 'https://api.github.com/repos/${config.repository}'`));
	assert.ok(ps.includes(`$PiBoltTagPrefix = '${config.tagPrefix}'`));
	assert.ok(cjs.includes(`const RELEASE_KEY = "${spki}";`));
	assert.ok(cjs.includes(`const REPO = "https://github.com/${config.repository}";`));
	assert.ok(cjs.includes(`const TAG_PREFIX = "${config.tagPrefix}";`));
	for (const file of files.slice(0, 3)) {
		const target = join(dir, file);
		const original = readFileSync(target, "utf8");
		writeFileSync(target, original.replace(config.repository, "other-owner/Other"));
		result = generate(dir, "--check");
		assert.equal(result.status, 1, file);
		assert.ok(result.stderr.includes(file), result.stderr);
		writeFileSync(target, original);
	}
	const target = join(dir, "install.sh");
	writeFileSync(target, readFileSync(target, "utf8").replace("# END GENERATED FORK CONFIG", "# missing marker"));
	result = generate(dir, "--check");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /exactly one generated fork config block/);
});

test("Windows: a regenerated fork uses its configured repository and tag prefix", async (t) => {
	const { dir, config } = forkFixture(t);
	const generated = generate(dir);
	assert.equal(generated.status, 0, generated.stderr);
	const fixtureInstall = require(join(dir, "npm/install.cjs"));
	const signer = newKey();
	const base = `https://github.com/${config.repository}/releases/download/${config.tagPrefix}${VERSION}`;
	const { fetch, asked } = fakeFetch(githubRoutes(makeRelease({ signer }), base));
	const result = await fixtureInstall.installWindows({
		pkgDir: makePackage(t), version: VERSION, env: { PROCESSOR_ARCHITECTURE: "AMD64" }, fetch, key: signer.key,
		runsVersion: () => true, hasAvx2: () => true, release: WINDOWS_10_1809, log: () => {},
	});
	assert.equal(result.from, "GitHub");
	assert.deepEqual(asked, [`${base}/SHA256SUMS`, `${base}/SHA256SUMS.sig`, `${base}/pi-bolt-win32-x64.zip`]);
});

function runShPlan(t, dir, env) {
	const script = readFileSync(join(dir, "install.sh"), "utf8");
	const testDir = mkdtempSync(join(tmpdir(), "pi-bolt-sh-plan-"));
	t.after(() => rmSync(testDir, { recursive: true, force: true }));
	const requests = join(testDir, "requests");
	const harness = [
		"preflight() { :; }",
		"logo_animation() { :; }",
		"uname() { case \"$1\" in -s) echo Linux ;; -m) echo x86_64 ;; esac; }",
		"is_termux() { return 1; }",
		"is_arm64() { return 1; }",
		"net_curl() {",
		"  for arg do url=$arg; done",
		"  printf '%s\\n' \"$url\" >>\"$TEST_REQUESTS\"",
		"  case \"$url\" in",
		"    \"$REPO/releases/latest\") printf '%s' \"$REPO/releases/tag/${TAG_PREFIX}1.2.3\" ;;",
		"    \"$API/releases?per_page=30\") printf '%s\\n' '  \"tag_name\": \"rel.v-1.2.3\",' '  \"tag_name\": \"relXv-9.9.9\",' '  \"tag_name\": \"rel.v-1.10.0\",' ;;",
		"    *) return 1 ;;",
		"  esac",
		"}",
		"fetch() { printf '%s\\n' \"$2\" >>\"$TEST_REQUESTS\"; printf 'hash  %s.tar.xz\\n' \"$NAME\" >\"$1\"; }",
		"probe() { printf '%s\\n' \"$1\" >>\"$TEST_REQUESTS\"; printf '%s 0 0\\n' \"$1\"; }",
		"can_unxz() { return 0; }",
		"install_release() { TMP=\"$TEST_TMP\"; mkdir -p \"$TMP\"; plan_download; printf 'RESULT %s %s\\n' \"$SHOWN_VERSION\" \"$BASE\"; }",
		"main \"$@\"",
	].join("\n");
	const file = join(testDir, "installer.sh");
	assert.match(script, /\nmain "\$@"\s*$/);
	writeFileSync(file, script.replace(/\nmain "\$@"\s*$/, `\n${harness}\n`));
	const result = spawnSync("sh", [file], {
		encoding: "utf8",
		env: { PATH: process.env.PATH, HOME: testDir, TEST_TMP: join(testDir, "plan"), TEST_REQUESTS: requests, PIBOLT_LAUNCHER: "1", PIBOLT_VARIANT: "x64", ...env },
	});
	return { ...result, asked: existsSync(requests) ? readFileSync(requests, "utf8").trim().split("\n") : [] };
}

test("POSIX: generated fork routes, beta selection, mirrors and npm rejection", { skip: (!findSh() || process.platform === "win32") && "no POSIX sh" }, (t) => {
	const { dir, config } = forkFixture(t);
	const generated = generate(dir);
	assert.equal(generated.status, 0, generated.stderr);
	const repo = `https://github.com/${config.repository}`;
	const api = `https://api.github.com/repos/${config.repository}`;
	const version = `${config.tagPrefix}1.2.3`;
	const explicit = runShPlan(t, dir, { PIBOLT_VERSION: version });
	assert.equal(explicit.status, 0, explicit.stderr);
	assert.deepEqual(explicit.asked, [`${repo}/releases/download/${version}/SHA256SUMS`, `${repo}/releases/download/${version}/pi-bolt-linux-x64.tar.xz`]);
	const latest = runShPlan(t, dir, {});
	assert.equal(latest.status, 0, latest.stderr);
	assert.deepEqual(latest.asked, [`${repo}/releases/latest`, `${repo}/releases/latest/download/SHA256SUMS`, `${repo}/releases/latest/download/pi-bolt-linux-x64.tar.xz`]);
	assert.match(latest.stdout, /RESULT 1\.2\.3 /);
	const beta = runShPlan(t, dir, { PIBOLT_CHANNEL: "beta" });
	assert.equal(beta.status, 0, beta.stderr);
	assert.deepEqual(beta.asked, [`${api}/releases?per_page=30`, `${repo}/releases/download/${config.tagPrefix}1.10.0/SHA256SUMS`, `${repo}/releases/download/${config.tagPrefix}1.10.0/pi-bolt-linux-x64.tar.xz`]);
	const mirror = runShPlan(t, dir, { PIBOLT_VERSION: version, PIBOLT_DOWNLOAD_BASE: "http://mirror.test/releases" });
	assert.equal(mirror.status, 0, mirror.stderr);
	assert.deepEqual(mirror.asked, ["http://mirror.test/releases/SHA256SUMS", "http://mirror.test/releases/pi-bolt-linux-x64.tar.xz"]);
	const npm = runShPlan(t, dir, { PIBOLT_SOURCE: "npm" });
	assert.notEqual(npm.status, 0);
	assert.match(npm.stderr, /PIBOLT_SOURCE=npm.*not supported/);
	assert.deepEqual(npm.asked, []);
	for (const invalid of ["relXv-1.2.3", "rel.v-1.2.3.4", "rel.v-1..3"]) {
		const result = runShPlan(t, dir, { PIBOLT_VERSION: invalid });
		assert.notEqual(result.status, 0, invalid);
		assert.match(result.stderr, /PIBOLT_VERSION must be a release tag/);
		assert.deepEqual(result.asked, []);
	}
});

test("POSIX: generated PEM and OpenSSH keys verify signatures and reject another signer", {
	skip: (!findSh() || process.platform === "win32" || !/^OpenSSL (?:[3-9]|[1-9]\d)/.test(spawnSync("openssl", ["version"], { encoding: "utf8" }).stdout || "") || spawnSync("ssh-keygen", ["-V"]).error) && "requires sh, OpenSSL 3 and ssh-keygen",
}, (t) => {
	const { dir, privateKey } = forkFixture(t);
	const generated = generate(dir);
	assert.equal(generated.status, 0, generated.stderr);
	const tmp = join(dir, "verify");
	mkdirSync(tmp);
	const sums = Buffer.from("# pi-bolt 1.2.3\n");
	const sumsFile = join(tmp, "SHA256SUMS");
	const keyFile = join(tmp, "fixture-key.pem");
	writeFileSync(sumsFile, sums);
	const script = readFileSync(join(dir, "install.sh"), "utf8");
	const runVerify = (ssh) => {
		const harness = [
			"set -eu",
			"setup_style",
			"TMP=\"$TEST_TMP\"; SHOWN_VERSION=1.2.3; SIG_PID=''; LAUNCHER=1; SIGNED=''; UNSIGNED=''; NOVERIFY=''",
			ssh ? "openssl3() { return 1; }" : "ssh_keygen_verifies() { return 1; }",
			"verify_signature",
			"printf 'signed=%s\\n' \"$SIGNED\"",
		].join("\n");
		const file = join(tmp, "harness.sh");
		writeFileSync(file, script.replace(/\nmain "\$@"\s*$/, `\n${harness}\n`));
		return spawnSync("sh", [file], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, TEST_TMP: tmp } });
	};
	const sign = (key) => {
		writeFileSync(keyFile, key.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
		writeFileSync(join(tmp, "SHA256SUMS.sig"), crypto.sign(null, sums, key));
		const result = spawnSync(process.execPath, [join(dir, "scripts/lib/sshsig.mjs"), "sign", keyFile, sumsFile, join(tmp, "SHA256SUMS.sshsig")], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	};
	sign(privateKey);
	for (const ssh of [false, true]) {
		const result = runVerify(ssh);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /signed=1/);
	}
	sign(crypto.generateKeyPairSync("ed25519").privateKey);
	for (const ssh of [false, true]) {
		const result = runVerify(ssh);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /signature does not verify/);
	}
});

test("in Pi-Bolt's repository the install script leaves the placeholder alone", () => {
	assert.equal(install.isSourceTree(npmDir.replace(/[\\/]$/, "")), true);
	assert.equal(install.isSourceTree(join(tmpdir(), "node_modules", "pi-bolt")), false);
});

// --- Windows ------------------------------------------------------------------------------------------------------------

test("Windows: auto installs only the fork's signed GitHub release", async (t) => {
	const signer = newKey();
	const release = makeRelease({ signer });
	const { fetch, asked } = fakeFetch({ ...githubRoutes(release), [npmUrl()]: Buffer.from("upstream package") });
	const pkgDir = makePackage(t);
	let ran;
	const { promise, log } = run(pkgDir, { fetch, key: signer.key, runsVersion: (exe) => ((ran = readFileSync(exe)), true) });
	assert.deepEqual(await promise, { variant: "x64", from: "GitHub", signed: true });
	assert.deepEqual(asked, [`${GITHUB}/SHA256SUMS`, `${GITHUB}/SHA256SUMS.sig`, `${GITHUB}/pi-bolt-win32-x64.zip`]);
	assert.deepEqual(ran, EXE, "the new executable ran (--version) before it was installed");
	assert.deepEqual(readFileSync(join(pkgDir, "bin", "pi-bolt.exe")), EXE);
	assert.equal(readFileSync(join(pkgDir, "bin", "theme", "dark.json"), "utf8"), "{}\n");
	assert.ok(existsSync(join(pkgDir, "bin", "native", "win32", "prebuilds", "win32-x64", "win32-platform.node")));
	assert.ok(existsSync(join(pkgDir, "bin", "pi-bolt.txt")));
	assert.deepEqual(readdirSync(pkgDir).sort(), ["bin", "package.json"], "the staging folder is gone");
	assert.match(log.join("\n"), /installed Pi-Bolt .* from GitHub, signature verified/);
});

test("Windows: a missing fork release never falls back to upstream npm", async (t) => {
	const { fetch, asked } = fakeFetch({ [npmUrl()]: Buffer.from("upstream package") });
	const pkgDir = makePackage(t);
	await assert.rejects(run(pkgDir, { fetch, key: newKey().key }).promise, /download failed/);
	assert.deepEqual(asked, [`${GITHUB}/SHA256SUMS`]);
	assertPlaceholder(pkgDir);
});

test("Windows: explicit npm source is rejected before any request", async (t) => {
	const { fetch, asked } = fakeFetch({});
	const pkgDir = makePackage(t);
	await assert.rejects(run(pkgDir, { fetch, key: newKey().key, env: { PIBOLT_SOURCE: "npm" } }).promise, /PIBOLT_SOURCE=npm.*not supported/i);
	assert.deepEqual(asked, []);
	assertPlaceholder(pkgDir);
});

test("Windows: PIBOLT_SOURCE=github downloads from the fork only", async (t) => {
	const signer = newKey();
	const release = makeRelease({ signer });
	const { fetch, asked } = fakeFetch(githubRoutes(release));
	const pkgDir = makePackage(t);
	assert.equal((await run(pkgDir, { fetch, key: signer.key, env: { PIBOLT_SOURCE: "github" } }).promise).from, "GitHub");
	assert.deepEqual(asked, [`${GITHUB}/SHA256SUMS`, `${GITHUB}/SHA256SUMS.sig`, `${GITHUB}/pi-bolt-win32-x64.zip`]);
});

test("Windows: a build from GitHub that does not match the checksum is refused", async (t) => {
	const signer = newKey();
	const release = makeRelease({ signer });
	release["pi-bolt-win32-x64.zip"] = buildZip("x64", [{ name: "pi-bolt-win32-x64/extra", data: Buffer.from("x") }]);
	const { fetch } = fakeFetch(githubRoutes(release));
	const pkgDir = makePackage(t);
	await assert.rejects(run(pkgDir, { fetch, key: signer.key }).promise, /checksum mismatch/);
	assertPlaceholder(pkgDir);
});

test("Windows: checksums signed with another key are refused before anything else is downloaded", async (t) => {
	const release = makeRelease({ signer: newKey() });
	const { fetch, asked } = fakeFetch(githubRoutes(release));
	const pkgDir = makePackage(t);
	await assert.rejects(run(pkgDir, { fetch, key: newKey().key }).promise, /signature does not verify: the download is not Pi-Bolt's/);
	assert.deepEqual(asked, [`${GITHUB}/SHA256SUMS`, `${GITHUB}/SHA256SUMS.sig`]);
	assertPlaceholder(pkgDir);
});

test("Windows: checksums changed after they were signed are refused", async (t) => {
	const signer = newKey();
	const release = makeRelease({ signer });
	release.SHA256SUMS = Buffer.concat([release.SHA256SUMS, Buffer.from(`${"0".repeat(64)}  other.zip\n`)]);
	const { fetch } = fakeFetch(githubRoutes(release));
	const pkgDir = makePackage(t);
	await assert.rejects(run(pkgDir, { fetch, key: signer.key }).promise, /signature does not verify/);
	assertPlaceholder(pkgDir);
});

test("Windows: the real release key does not accept a fake release", async (t) => {
	const release = makeRelease({ signer: newKey() });
	const { fetch } = fakeFetch(githubRoutes(release));
	const pkgDir = makePackage(t);
	await assert.rejects(run(pkgDir, { fetch, key: install.RELEASE_KEY }).promise, /signature does not verify/);
	assertPlaceholder(pkgDir);
});

test("Windows: a release without a signature is refused from GitHub", async (t) => {
	const signer = newKey();
	const { fetch } = fakeFetch(githubRoutes(makeRelease()));
	const pkgDir = makePackage(t);
	await assert.rejects(run(pkgDir, { fetch, key: signer.key }).promise, /has no signature \(SHA256SUMS\.sig\)/);
	assertPlaceholder(pkgDir);
});

test("Windows: a mirror (PIBOLT_DOWNLOAD_BASE) without a signature is refused", async (t) => {
	const release = makeRelease();
	const { fetch } = fakeFetch(githubRoutes(release, "http://mirror.test/pi-bolt"));
	const pkgDir = makePackage(t);
	await assert.rejects(
		run(pkgDir, { fetch, key: install.RELEASE_KEY, env: { PIBOLT_DOWNLOAD_BASE: "http://mirror.test/pi-bolt/" } }).promise,
		/has no signature/,
	);
	assertPlaceholder(pkgDir);
});

// An opt-in left in the environment (a profile, setx, a CI image) would otherwise let any later download in without its signature.
test("Windows: PIBOLT_ALLOW_UNSIGNED=1, or the SHA-256 of other checksums, does not let an unsigned release in", async (t) => {
	const release = makeRelease();
	const other = sha256(makeRelease({ sumsVersion: "0.0.1" }).SHA256SUMS);
	for (const value of ["1", "yes", other]) {
		const { fetch } = fakeFetch(githubRoutes(release, "http://mirror.test/pi-bolt"));
		const pkgDir = makePackage(t);
		const env = { PIBOLT_DOWNLOAD_BASE: "http://mirror.test/pi-bolt", PIBOLT_ALLOW_UNSIGNED: value };
		await assert.rejects(run(pkgDir, { fetch, key: install.RELEASE_KEY, env }).promise, (error) => {
			assert.match(error.message, /has no signature/);
			assert.match(error.message, /not to this download's SHA-256/);
			assert.ok(error.message.includes(`PIBOLT_ALLOW_UNSIGNED=${sha256(release.SHA256SUMS)}`), "it says the value for this download");
			return true;
		});
		assertPlaceholder(pkgDir);
	}
});

test("Windows: an unsigned release only with PIBOLT_ALLOW_UNSIGNED set to the SHA-256 of its SHA256SUMS, with a warning", async (t) => {
	const mirror = "http://mirror.test/pi-bolt/";
	const release = makeRelease();
	const { fetch, asked } = fakeFetch(githubRoutes(release, "http://mirror.test/pi-bolt"));
	const pkgDir = makePackage(t);
	const env = { PIBOLT_DOWNLOAD_BASE: mirror, PIBOLT_ALLOW_UNSIGNED: sha256(release.SHA256SUMS).toUpperCase() };
	const { promise, log } = run(pkgDir, { fetch, key: install.RELEASE_KEY, env });
	assert.deepEqual(await promise, { variant: "x64", from: "http://mirror.test/pi-bolt", signed: false });
	assert.ok(asked.every((url) => url.startsWith("http://mirror.test/pi-bolt/")));
	assert.match(log.join("\n"), /WARNING: http:\/\/mirror\.test\/pi-bolt has no signature for this release \(SHA256SUMS\.sig\)/);
});

test("Windows: a signature that does not verify is refused, PIBOLT_ALLOW_UNSIGNED or not", async (t) => {
	const release = makeRelease({ signer: newKey() });
	const { fetch } = fakeFetch(githubRoutes(release, "http://mirror.test"));
	const pkgDir = makePackage(t);
	const env = { PIBOLT_DOWNLOAD_BASE: "http://mirror.test", PIBOLT_ALLOW_UNSIGNED: sha256(release.SHA256SUMS) };
	await assert.rejects(run(pkgDir, { fetch, key: install.RELEASE_KEY, env }).promise, /signature does not verify/);
	assertPlaceholder(pkgDir);
});

test("Windows: a mirror's signature is checked all the same", async (t) => {
	const release = makeRelease({ signer: newKey() });
	const { fetch } = fakeFetch(githubRoutes(release, "http://mirror.test"));
	const pkgDir = makePackage(t);
	await assert.rejects(run(pkgDir, { fetch, key: install.RELEASE_KEY, env: { PIBOLT_DOWNLOAD_BASE: "http://mirror.test" } }).promise, /signature does not verify/);
	assertPlaceholder(pkgDir);
});

test("Windows: checksums of another version, or that do not say their version, are refused", async (t) => {
	const signer = newKey();
	for (const [release, error] of [
		[makeRelease({ signer, sumsVersion: "0.1.0" }), /the download is Pi-Bolt 0\.1\.0, not .* \(an older release served as a newer one\?\)/],
		[makeRelease({ signer, firstLine: "# checksums" }), /does not say which version it is/],
	]) {
		const { fetch } = fakeFetch(githubRoutes(release));
		const pkgDir = makePackage(t);
		await assert.rejects(run(pkgDir, { fetch, key: signer.key }).promise, error);
		assertPlaceholder(pkgDir);
	}
});

test("Windows: a release without a Windows build, or without the variant asked for, is refused", async (t) => {
	const signer = newKey();
	const { fetch } = fakeFetch(githubRoutes(makeRelease({ signer, zips: {} })));
	await assert.rejects(run(makePackage(t), { fetch, key: signer.key }).promise, /has no Windows build x64 \(pi-bolt-win32-x64\.zip is not in its SHA256SUMS\)/);
	const other = fakeFetch(githubRoutes(makeRelease({ signer })));
	await assert.rejects(run(makePackage(t), { fetch: other.fetch, key: signer.key, env: { PIBOLT_VARIANT: "x64-jit" } }).promise, /pi-bolt-win32-x64-jit\.zip is not in its SHA256SUMS/);
	await assert.rejects(run(makePackage(t), { fetch: other.fetch, key: signer.key, env: { PIBOLT_VARIANT: "arm64" } }).promise, /PIBOLT_VARIANT must be x64, x64-baseline or x64-jit/);
	await assert.rejects(run(makePackage(t), { fetch: other.fetch, key: signer.key, env: { PIBOLT_SOURCE: "ftp" } }).promise, /PIBOLT_SOURCE must be auto or github/);
});

test("Windows: the baseline build on a CPU without AVX2, when the release has one", async (t) => {
	const signer = newKey();
	const release = makeRelease({ signer, zips: { x64: buildZip("x64"), "x64-baseline": buildZip("x64-baseline") } });
	const { fetch } = fakeFetch(githubRoutes(release));
	assert.equal((await run(makePackage(t), { fetch, key: signer.key, hasAvx2: () => false }).promise).variant, "x64-baseline");
	assert.equal((await run(makePackage(t), { fetch, key: signer.key, hasAvx2: () => true }).promise).variant, "x64");
	const onlyX64 = fakeFetch(githubRoutes(makeRelease({ signer })));
	let asked = false;
	const result = await run(makePackage(t), { fetch: onlyX64.fetch, key: signer.key, hasAvx2: () => ((asked = true), false) }).promise;
	assert.equal(result.variant, "x64");
	assert.equal(asked, false, "the CPU is only looked at when the release has a baseline build");
});

test("Windows: an executable that does not run is not installed", async (t) => {
	const signer = newKey();
	const { fetch } = fakeFetch(githubRoutes(makeRelease({ signer })));
	const pkgDir = makePackage(t);
	await assert.rejects(run(pkgDir, { fetch, key: signer.key, runsVersion: () => false }).promise, /does not run on this system/);
	assertPlaceholder(pkgDir);
});

test("Windows: a .zip with an entry outside its folder is refused, signed or not", async (t) => {
	const signer = newKey();
	for (const name of ["pi-bolt-win32-x64/../../evil.exe", "../evil.exe", "/evil.exe", "C:/evil.exe", "pi-bolt-win32-x64\\..\\evil.exe"]) {
		const release = makeRelease({ signer, zips: { x64: buildZip("x64", [{ name, data: Buffer.from("x") }]) } });
		const { fetch } = fakeFetch(githubRoutes(release));
		const pkgDir = makePackage(t);
		await assert.rejects(run(pkgDir, { fetch, key: signer.key }).promise, /an entry outside its folder/, name);
		assertPlaceholder(pkgDir);
	}
});

test("Windows: an older Windows is refused before anything is downloaded", async (t) => {
	const { fetch, asked } = fakeFetch({});
	const pkgDir = makePackage(t);
	const promise = install.installWindows({ pkgDir, version: VERSION, env: {}, fetch, release: "10.0.17134", log: () => {} });
	await assert.rejects(promise, /needs Windows 10 version 1809 or later \(this is build 17134\)/);
	assert.deepEqual(asked, []);
	assert.match(install.windowsProblems({ PROCESSOR_ARCHITECTURE: "x86" }, WINDOWS_10_1809).join(), /runs on x86-64 \(this is x86\)/);
	assert.deepEqual(install.windowsProblems({ PROCESSOR_ARCHITECTURE: "x86", PROCESSOR_ARCHITEW6432: "AMD64" }, WINDOWS_10_1809), []);
	assert.deepEqual(install.windowsProblems({ PROCESSOR_ARCHITECTURE: "ARM64" }, "10.0.26100"), []);
	// Windows 10 on ARM has no x64 emulation.
	assert.match(install.windowsProblems({ PROCESSOR_ARCHITECTURE: "ARM64" }, "10.0.19045").join(), /On ARM, Pi-Bolt needs Windows 11/);
});

test("Windows: installing again replaces the files that are there", async (t) => {
	const signer = newKey();
	const { fetch } = fakeFetch(githubRoutes(makeRelease({ signer })));
	const pkgDir = makePackage(t);
	await run(pkgDir, { fetch, key: signer.key }).promise;
	writeFileSync(join(pkgDir, "bin", "theme", "dark.json"), "changed");
	await run(pkgDir, { fetch, key: signer.key }).promise;
	assert.equal(readFileSync(join(pkgDir, "bin", "theme", "dark.json"), "utf8"), "{}\n");
	assert.deepEqual(readFileSync(join(pkgDir, "bin", "pi-bolt.exe")), EXE);
	const leftovers = readdirSync(join(pkgDir, "bin"), { recursive: true }).filter((name) => String(name).endsWith(".pibolt-old"));
	assert.deepEqual(leftovers, []);
});

test("the checksums' lines, as sha256sum writes them", () => {
	const sums = `# pi-bolt ${VERSION}\n${"a".repeat(64)}  pi-bolt-win32-x64.zip\n${"B".repeat(64)} *other.zip\n`;
	assert.equal(install.checksumOf(sums, "pi-bolt-win32-x64.zip"), "a".repeat(64));
	assert.equal(install.checksumOf(sums, "other.zip"), "b".repeat(64));
	assert.equal(install.checksumOf(sums, "win32-x64.zip"), undefined);
	assert.equal(install.checksumOf(sums, "pi-bolt-win32-x64"), undefined);
});

// --- Linux and macOS ----------------------------------------------------------------------------------------------------

test("Linux and macOS: the install script puts the launcher, with its #!/bin/sh, over the placeholder", (t) => {
	const pkgDir = makePackage(t);
	install.installPosix({ pkgDir });
	const launcher = readFileSync(join(npmDir, "bin", "pi-bolt"));
	assert.deepEqual(readFileSync(join(pkgDir, "bin", "pi-bolt.exe")), launcher);
	if (process.platform !== "win32") assert.equal(statSync(join(pkgDir, "bin", "pi-bolt.exe")).mode & 0o777, 0o755);
	install.installPosix({ pkgDir });
	assert.deepEqual(readFileSync(join(pkgDir, "bin", "pi-bolt.exe")), launcher);
	assert.deepEqual(readdirSync(join(pkgDir, "bin")).sort(), ["pi-bolt", "pi-bolt.exe"]);
});

/** sh, if there is one (Git's on Windows). */
function findSh() {
	const result = spawnSync("sh", ["-c", "echo ok"], { encoding: "utf8" });
	return result.status === 0 && result.stdout.trim() === "ok";
}

function fakeUname(dir, system) {
	const bin = join(dir, "fake-bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "uname"), `#!/bin/sh\necho ${system}\n`);
	chmodSync(join(bin, "uname"), 0o755);
	return bin;
}

test("the placeholder, run without the install script: on Linux it starts the launcher; elsewhere it says what to run", { skip: !findSh() && "no sh" }, (t) => {
	const pkgDir = makePackage(t);
	const separator = process.platform === "win32" ? ";" : ":";
	// Elsewhere (Git Bash on Windows): how to run the install script, and a failure.
	const windows = spawnSync("sh", [join(pkgDir, "bin", "pi-bolt.exe"), "--version"], {
		encoding: "utf8",
		env: { ...process.env, PATH: `${fakeUname(pkgDir, "MINGW64_NT-10.0-26200")}${separator}${process.env.PATH}` },
	});
	assert.equal(windows.status, 1);
	assert.match(windows.stderr, /the package's install script did not run/);
	assert.match(windows.stderr, /node ".*\/install\.cjs"/);
	// Linux: the launcher, which works without the install script (here, with PIBOLT_HOME set to where a "build" is).
	const home = join(pkgDir, "home");
	const dir = join(home, "npm", VERSION, "pi-bolt-linux-x64");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "pi"), '#!/bin/sh\necho "the build: $*"\n');
	chmodSync(join(dir, "pi"), 0o755);
	const linux = spawnSync("sh", [join(pkgDir, "bin", "pi-bolt.exe"), "--version"], {
		encoding: "utf8",
		env: { ...process.env, PIBOLT_HOME: home, PIBOLT_VARIANT: "x64", PATH: `${fakeUname(pkgDir, "Linux")}${separator}${process.env.PATH}` },
	});
	assert.equal(linux.stdout, "the build: --version\n", linux.stderr);
	assert.equal(linux.status, 0);
});

test("the launcher's first run of a version removes the versions installed before it", { skip: (!findSh() || process.platform === "win32") && "no sh" }, (t) => {
	const pkgDir = makePackage(t);
	const home = join(pkgDir, "home");
	// The installer, as far as the launcher sees it: it puts the build where PIBOLT_INSTALL says.
	writeFileSync(
		join(pkgDir, "install.sh"),
		'mkdir -p "$PIBOLT_INSTALL/pi-bolt-linux-x64" && printf \'#!/bin/sh\\necho "the build: $*"\\n\' > "$PIBOLT_INSTALL/pi-bolt-linux-x64/pi" && chmod 755 "$PIBOLT_INSTALL/pi-bolt-linux-x64/pi"\n',
	);
	mkdirSync(join(home, "npm", "0.7.4", "pi-bolt-linux-x64"), { recursive: true });
	mkdirSync(join(home, "npm", "notes"), { recursive: true });
	// A session of 0.7.3 that is still running keeps its folder.
	const running = join(home, "npm", "0.7.3", "pi-bolt-linux-x64");
	mkdirSync(running, { recursive: true });
	writeFileSync(join(running, "pi"), "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
	const session = spawn(join(running, "pi"), [], { stdio: "ignore" });
	t.after(() => session.kill());
	const result = spawnSync("sh", [join(pkgDir, "bin", "pi-bolt"), "--version"], {
		encoding: "utf8",
		env: { ...process.env, PIBOLT_HOME: home, PIBOLT_VARIANT: "x64", PATH: `${fakeUname(pkgDir, "Linux")}:${process.env.PATH}` },
	});
	assert.equal(result.stdout, "the build: --version\n", result.stderr);
	assert.equal(result.status, 0);
	assert.deepEqual(readdirSync(join(home, "npm")).sort(), ["0.7.3", VERSION, "notes"]);
});

// The first run is not asked for by the user: an opt-in to installing without a signature check, left in their environment, is
// not passed on to the installer (which ignores it in the first run as well).
test("the launcher's first run does not pass PIBOLT_UNVERIFIED on to the installer", { skip: (!findSh() || process.platform === "win32") && "no sh" }, (t) => {
	const pkgDir = makePackage(t);
	const home = join(pkgDir, "home");
	writeFileSync(
		join(pkgDir, "install.sh"),
		'mkdir -p "$PIBOLT_INSTALL/pi-bolt-linux-x64" && printf \'#!/bin/sh\\necho "the build"\\n\' > "$PIBOLT_INSTALL/pi-bolt-linux-x64/pi" && chmod 755 "$PIBOLT_INSTALL/pi-bolt-linux-x64/pi"\necho "installer: PIBOLT_UNVERIFIED=${PIBOLT_UNVERIFIED-unset} PIBOLT_LAUNCHER=$PIBOLT_LAUNCHER" >&2\n',
	);
	const result = spawnSync("sh", [join(pkgDir, "bin", "pi-bolt")], {
		encoding: "utf8",
		env: {
			...process.env,
			PIBOLT_HOME: home,
			PIBOLT_VARIANT: "x64",
			PIBOLT_UNVERIFIED: "1",
			PATH: `${fakeUname(pkgDir, "Linux")}:${process.env.PATH}`,
		},
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /installer: PIBOLT_UNVERIFIED=unset PIBOLT_LAUNCHER=1/);
	assert.equal(result.stdout, "the build\n");
});

test("an archive entry's name: inside its folder, with / between its parts and no \\, :, .. or empty part", () => {
	for (const name of ["pi-bolt-win32-x64/pi-bolt.exe", "pi-bolt-win32-x64/", "a/b/c.txt"]) assert.equal(install.isSafeEntryName(name), true, name);
	for (const name of ["", "/x", "C:/x", "a/../x", "a//x", "./x", "a\\x", "pi-bolt-win32-x64/..\\..\\x", "a\0x"]) {
		assert.equal(install.isSafeEntryName(name), false, JSON.stringify(name));
	}
});

test("the proxy to download through: the environment's, then npm's configuration", () => {
	assert.equal(install.proxyOf({}), "");
	assert.equal(install.proxyOf({ npm_config_proxy: "http://p:1" }), "http://p:1");
	assert.equal(install.proxyOf({ npm_config_proxy: "http://p:1", npm_config_https_proxy: "http://s:2" }), "http://s:2");
	assert.equal(install.proxyOf({ npm_config_https_proxy: "http://s:2", HTTPS_PROXY: "http://e:3" }), "http://e:3");
});

test("a mirror's or registry's address without the slashes it ends with: as .replace(/\\/+$/, \"\") had it", () => {
	// Every string of up to 9 characters from "/", "a" and ":" (29,524 of them), and some longer ones.
	const inputs = [""];
	for (let length = 1, last = [""]; length <= 9; length++) {
		last = last.flatMap((prefix) => ["/", "a", ":"].map((c) => prefix + c));
		inputs.push(...last);
	}
	inputs.push("https://registry.npmjs.org", "http://mirror.test/pi-bolt/", "http://mirror.test//pi//bolt///", "/".repeat(1000));
	for (const input of inputs) assert.equal(install.withoutTrailingSlashes(input), input.replace(/\/+$/, ""), JSON.stringify(input));
	// Linear in the length: a long run of slashes not at the end takes no time.
	const long = `${"/".repeat(200_000)}a`;
	const started = performance.now();
	assert.equal(install.withoutTrailingSlashes(long), long);
	assert.equal(install.withoutTrailingSlashes(`${long}${"/".repeat(200_000)}`), long);
	assert.ok(performance.now() - started < 1000);
});
