#!/usr/bin/env bash
# Builds the fork's Pi-Bolt locally, into out/, and stages it for install.sh: the driver and the compile kit from this
# checkout, then the official `pi compile` with the extensions the installed build has compiled in
# (${PIBOLT_HOME:-$HOME/.pi-bolt}/compile.json). The installation is not touched.
#
# Usage: rebuild.sh
#
# What it does: reuses the release runtime in .work/runtime (or the installer's cache, or downloads it), builds Pi if a
# source changed since its package was built, builds the driver and the kit, compiles in the extensions, verifies the
# result (--version, its compiled code, the patch's extension API), writes out/pi-bolt-compiled/fork-build.json and
# reports `staged`.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib.sh"
fork_require_linux_x64
need git
need python3
need tar
need node
need npm

PIBOLT_VERSION="$(fork_version)"
[ -n "$PIBOLT_VERSION" ] || die "no VERSION file in $FORK_ROOT"
COMPILE_JSON="$FORK_HOME/compile.json"
BUILD="$FORK_ROOT/out/pi-bolt"
KIT_DIR="$FORK_ROOT/out/kit/pi-bolt-kit-linux-x64"
KIT_TAR="$FORK_ROOT/out/kit/pi-bolt-kit-linux-x64.tar.gz"
STAGED="$FORK_ROOT/out/pi-bolt-compiled"
RUNTIME_DIR="$FORK_ROOT/.work/runtime"
RUNTIME_BUN="$RUNTIME_DIR/bun"
CACHE="$FORK_HOME/cache"
LOG="$FORK_STATE/rebuild.log"
# The compile unpacks the kit beside its --out, and Bun then resolves a package's dependencies by walking up from there:
# inside a checkout it finds the checkout's node_modules (canvas, installed without its native binding) and leaves that
# extension out. So the build is made under $TMPDIR and moved into out/ afterwards.
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/pibolt-fork-build.XXXXXX")"
BUILT="$SCRATCH/pi-bolt-compiled"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$FORK_STATE"

fail() {
	fork_status failed "$1"
	exit 1
}

# ensure_runtime: a release runtime, with the stamp that says which engine it is, for the release this checkout is at.
# The stamp is what scripts/runtime-stamp.sh derives from the engine Pi-Bolt builds on (sources.json, the patches): a
# runtime with another stamp is another engine, and the build would report it as such.
ensure_runtime() {
	local want have cached
	want="$("$FORK_ROOT/scripts/runtime-stamp.sh" 2>/dev/null || true)"
	have="$(cat "$RUNTIME_DIR/RUNTIME_STAMP" 2>/dev/null || true)"
	if [ -x "$RUNTIME_BUN" ] && [ -n "$want" ] && [ "$have" = "$want" ]; then
		log "runtime: reusing $RUNTIME_BUN (Bun $("$RUNTIME_BUN" --version), stamp $have), nothing downloaded"
		return 0
	fi
	warn "the runtime in $RUNTIME_DIR is $([ -x "$RUNTIME_BUN" ] && echo "stamp ${have:-not recorded}" || echo "missing"), and this checkout's is ${want:-unknown}"
	cached="$(cached_runtime)" || cached=""
	if [ -n "$cached" ]; then
		log "runtime: unpacking $cached (the release's, checked against its signed checksums), nothing downloaded"
		rm -rf "$RUNTIME_DIR"
		mkdir -p "$RUNTIME_DIR"
		tar -C "$SCRATCH" -xzf "$cached"
		mv "$SCRATCH/pi-bolt-runtime-linux-x64/bun" "$RUNTIME_BUN"
		rm -rf "$SCRATCH/pi-bolt-runtime-linux-x64"
		# The runtime archive carries no stamp of its own; this is the one build-runtime.sh derives for the release.
		[ -z "$want" ] || printf '%s\n' "$want" >"$RUNTIME_DIR/RUNTIME_STAMP"
	else
		log "runtime: downloading the release runtime for bolt-v$PIBOLT_VERSION (about 50 MB, signature verified) into $RUNTIME_DIR"
		"$FORK_ROOT/scripts/fetch-runtime.sh" --version "bolt-v$PIBOLT_VERSION" ||
			fail "could not fetch the runtime for bolt-v$PIBOLT_VERSION (see the output above)"
		have="$(cat "$RUNTIME_DIR/RUNTIME_STAMP" 2>/dev/null || true)"
		[ -z "$want" ] || [ "$have" = "$want" ] ||
			warn "the release's runtime has stamp ${have:-none}, this checkout's is $want: the build reports the release's"
	fi
	[ -x "$RUNTIME_BUN" ] || fail "no runtime at $RUNTIME_BUN"
}

# cached_runtime: the release's runtime archive in the installer's cache, when the cache's checksums are this release's
# signed ones and the archive matches them. Prints its path, or nothing.
cached_runtime() {
	local sums="$CACHE/SHA256SUMS" sig="$CACHE/SHA256SUMS.sig" sha file
	[ -f "$sums" ] && [ -f "$sig" ] || return 1
	[ "$(head -n 1 "$sums")" = "# pi-bolt $PIBOLT_VERSION" ] || return 1
	sha="$(grep -E "^[0-9a-f]{64} [ *]?pi-bolt-runtime-linux-x64\.tar\.gz$" "$sums" | cut -d' ' -f1)"
	[ -n "$sha" ] || return 1
	file="$CACHE/${sha:0:16}-pi-bolt-runtime-linux-x64.tar.gz"
	[ -f "$file" ] || return 1
	[ "$(sha256_file "$file")" = "$sha" ] || return 1
	printf '%s\n' "$file"
}

# stale_sources: a source file that changed since its package was built (Pi is made from each package's dist).
stale_sources() {
	local package built stale
	for package in "$FORK_ROOT"/packages/*/; do
		[ -d "$package/src" ] && [ -d "$package/dist" ] || continue
		built="$(find "$package/dist" -maxdepth 1 -name '*.js' -print -quit)"
		[ -n "$built" ] || continue
		stale="$(find "$package/src" -name '*.ts' ! -name '*.d.ts' -newer "$built" -print -quit)"
		[ -z "$stale" ] || printf '%s\n' "$stale"
	done
}

# prepare_pi: Pi's packages are what the build reads. A cold checkout is prepared by scripts/prepare-pi.sh (npm ci, then
# the build); with node_modules at the lockfile it is the build alone, which keeps a merge from installing everything
# again.
prepare_pi() {
	local stale log="$FORK_STATE/prepare-pi.log"
	if [ ! -f "$FORK_ROOT/packages/coding-agent/dist/bun/cli.js" ]; then
		stale="packages/coding-agent/dist is missing"
	else
		stale="$(stale_sources)"
	fi
	if [ -z "$stale" ]; then
		log "Pi is built (no source is newer than its package's dist), nothing to prepare"
		return 0
	fi
	if [ ! -d "$FORK_ROOT/node_modules" ] || [ "$FORK_ROOT/package-lock.json" -nt "$FORK_ROOT/node_modules/.package-lock.json" ]; then
		log "preparing Pi with scripts/prepare-pi.sh (installing the packages its lockfile names): $stale"
		"$FORK_ROOT/scripts/prepare-pi.sh" || fail "scripts/prepare-pi.sh failed (the whole output: $FORK_ROOT/.work/prepare-pi.log)"
		return 0
	fi
	log "building Pi's packages (node_modules is current, so only the build): $stale"
	if ! (cd "$FORK_ROOT" && npm run build:offline) >"$log" 2>&1; then
		tail -n 30 "$log" >&2
		fail "'npm run build:offline' failed in $FORK_ROOT (the whole output: $log)"
	fi
}

build_driver_and_kit() {
	log "building the driver and the compile kit for Pi-Bolt $PIBOLT_VERSION"
	PIBOLT_BUN="$RUNTIME_BUN" "$FORK_ROOT/scripts/build-pi.sh" --out "$BUILD" --kit "$KIT_DIR" ||
		fail "scripts/build-pi.sh failed"
	[ -f "$KIT_DIR/kit.json" ] || fail "no kit at $KIT_DIR"
	# As scripts/package-release.sh packs it: the kit folder as the archive's single top entry, owned by 0/0.
	rm -f "$KIT_TAR"
	tar --owner=0 --group=0 --numeric-owner -C "$(dirname "$KIT_DIR")" -czf "$KIT_TAR" "$(basename "$KIT_DIR")" ||
		fail "could not pack the kit"
	# The build directory holds every file of the distribution: scripts/package-release.sh adds the licences, and the
	# compile copies what it finds there.
	cp "$FORK_ROOT/LICENSE" "$BUILD/LICENSE"
	cp "$FORK_ROOT/LICENSE" "$BUILD/LICENSE.pi"
	cp "$FORK_ROOT/THIRD_PARTY_NOTICES.md" "$BUILD/THIRD_PARTY_NOTICES.md"
}

# compile_in: the official compile, with the extensions the installed build has compiled in, into $BUILT.
compile_in() {
	local names expected missing extra name
	expected="$(python3 -c 'import json, sys; print("\n".join(json.load(open(sys.argv[1]))["extensions"]))' "$COMPILE_JSON")" ||
		fail "$COMPILE_JSON is not a compile record"
	[ -n "$expected" ] || fail "$COMPILE_JSON names no extension: nothing to compile in"
	EXTENSIONS_COUNT="$(printf '%s\n' "$expected" | wc -l | tr -d ' ')"
	log "compiling in $EXTENSIONS_COUNT extensions from $COMPILE_JSON"
	if ! "$BUILD/pi" compile --kit "$KIT_TAR" --runtime "$RUNTIME_BUN" --out "$BUILT" >"$LOG" 2>&1; then
		tail -n 30 "$LOG" >&2
		fail "the compile failed (the whole output: $LOG)"
	fi
	names="$(sed -e 's/\x1b\[[0-9;]*m//g' "$LOG" | sed -n 's/^Built Pi-Bolt [^ ]* with \(.*\) compiled in.*$/\1/p' | tail -1 | tr ',' ' ')"
	[ -n "$names" ] || fail "the compile printed no extension list (the whole output: $LOG)"
	missing=""
	for name in $expected; do
		case " $names " in *" $name "*) ;; *) missing="$missing $name" ;; esac
	done
	[ -z "$missing" ] || fail "the compile left out these extensions of $COMPILE_JSON:$missing
The compile's output: $LOG"
	extra=""
	for name in $names; do
		case " $(printf '%s' "$expected" | tr '\n' ' ') " in *" $name "*) ;; *) extra="$extra $name" ;; esac
	done
	[ -z "$extra" ] || warn "the compile also took extensions $COMPILE_JSON does not name:$extra"
}

# probe_patch_api: the patch's extension API, in RPC mode with a probe extension, in an isolated HOME, so that no
# configured extension or agent directory is involved.
probe_patch_api() {
	local dir="$SCRATCH/probe" result
	mkdir -p "$dir"
	cat >"$dir/probe.ts" <<'TS'
import { writeFileSync } from "node:fs";
export default function (pi: { registerTranscriptProjection?: unknown }): void {
	writeFileSync(process.env.PIBOLT_PROBE_OUT as string, typeof pi.registerTranscriptProjection);
}
TS
	result="$dir/result"
	(
		cd "$dir" &&
			HOME="$dir/home" PI_CODING_AGENT_DIR="$dir/agent" \
				XDG_CONFIG_HOME="$dir/home/.config" XDG_DATA_HOME="$dir/home/.local/share" \
				XDG_STATE_HOME="$dir/home/.local/state" XDG_CACHE_HOME="$dir/home/.cache" \
				PIBOLT_PROBE_OUT="$result" \
				"$BUILT/pi" --mode rpc --offline --no-session -e "$dir/probe.ts" </dev/null >"$dir/rpc.log" 2>&1
	) || true
	[ "$(cat "$result" 2>/dev/null)" = function ] || {
		tail -n 10 "$dir/rpc.log" >&2
		fail "the patch's pi.registerTranscriptProjection is not a function in the built Pi-Bolt"
	}
}

# write_marker: what this build is -- the commit install.sh checks, and the update command the fork-build guard runs.
write_marker() {
	MARKER_OUT="$BUILT/fork-build.json" MARKER_FORK="furbyhaxx/Pi-Bolt" MARKER_BRANCH="$FORK_BRANCH" \
		MARKER_COMMIT="$(fork_commit)" MARKER_VERSION="$PIBOLT_VERSION" \
		MARKER_CHECKOUT="$FORK_ROOT" MARKER_KIT="$KIT_TAR" MARKER_RUNTIME="$RUNTIME_BUN" python3 - <<'PY'
import datetime, json, os
marker = {
	"schema": 1,
	"fork": os.environ["MARKER_FORK"],
	"branch": os.environ["MARKER_BRANCH"],
	"commit": os.environ["MARKER_COMMIT"],
	"upstreamVersion": os.environ["MARKER_VERSION"],
	"builtAt": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
	"checkout": os.environ["MARKER_CHECKOUT"],
	"updateCommand": [os.path.join(os.environ["MARKER_CHECKOUT"], "scripts", "fork", "update.sh")],
	"kit": os.environ["MARKER_KIT"],
	"runtime": os.environ["MARKER_RUNTIME"],
}
with open(os.environ["MARKER_OUT"], "w") as fh:
	json.dump(marker, fh, indent="\t")
	fh.write("\n")
PY
}

verify() {
	local version_line
	version_line="$("$BUILT/pi" --version 2>&1)" || fail "the built Pi-Bolt does not run: $version_line"
	case "$version_line" in
	*"Pi-Bolt $PIBOLT_VERSION"*) ;;
	*) fail "the built Pi-Bolt is not Pi-Bolt $PIBOLT_VERSION: $version_line" ;;
	esac
	BUN_STATIC_HEAP_VERBOSE=1 "$BUILT/pi" --version 2>&1 | grep -q "image registered: true" ||
		fail "the built Pi-Bolt does not use its compiled code"
	probe_patch_api
	printf '%s\n' "$version_line"
}

main() {
	[ -f "$COMPILE_JSON" ] || fail "no $COMPILE_JSON: the installed build records the extensions a fork build compiles in"
	ensure_runtime
	prepare_pi
	build_driver_and_kit
	compile_in
	verify
	write_marker
	rm -rf "$STAGED"
	mv "$BUILT" "$STAGED"
	fork_status staged "$("$STAGED/pi" --version): $EXTENSIONS_COUNT extensions, staged in $STAGED (commit $(git -C "$FORK_ROOT" rev-parse --short HEAD))"
	log "staged: $STAGED"
}

main
