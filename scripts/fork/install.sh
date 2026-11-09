#!/usr/bin/env bash
# Installs the staged fork build (out/pi-bolt-compiled) over ${PIBOLT_HOME:-$HOME/.pi-bolt}/pi-bolt-linux-x64, keeping the
# build it replaces as pi-bolt-linux-x64.keep-YYYYmmdd-HHMMSS. --rollback puts the newest kept build back.
#
# Usage: install.sh [--rollback]
#
# The installer's own pi-bolt-linux-x64.previous (what `pi-bolt update --rollback` swaps) is never touched. A build whose
# --version does not work after the swap is rolled back at once; the one it replaces is kept as
# .rejected-YYYYmmdd-HHMMSS.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib.sh"
fork_require_linux_x64
need git
need python3

STAGED="$FORK_ROOT/out/pi-bolt-compiled"
ROLLBACK=""
case "${1:-}" in
--rollback) ROLLBACK=1 ;;
"") ;;
-h | --help) sed -n '2,9p' "$0"; exit 0 ;;
*) die "unknown option $1" ;;
esac

fail() {
	fork_status failed "$1"
	exit 1
}

# version_of DIR: prints what DIR/pi answers to --version; fails when it does not run.
version_of() {
	if [ ! -x "$1/pi" ]; then
		printf '%s\n' "no executable at $1/pi"
		return 1
	fi
	"$1/pi" --version 2>&1
}

# staged_build: the staged build is this checkout's, made from its commit, and it runs.
staged_build() {
	local marker="$STAGED/fork-build.json" commit head version
	[ -x "$STAGED/pi" ] || fail "no staged build at $STAGED/pi: run scripts/fork/rebuild.sh"
	[ -f "$marker" ] || fail "no $marker: the staged build is not a fork build (run scripts/fork/rebuild.sh)"
	commit="$(fork_json_value "$marker" commit)"
	[ -n "$commit" ] || fail "$marker names no commit"
	head="$(fork_commit)"
	[ "$commit" = "$head" ] ||
		fail "the staged build is commit $commit and the checkout is at $head: run scripts/fork/rebuild.sh"
	version="$(version_of "$STAGED")" || fail "the staged build does not run: $version"
}

install_staged() {
	local keep reject version
	staged_build
	keep="$(free_path "$FORK_INSTALL.keep-$(fork_stamp)")"
	mkdir -p "$FORK_HOME"
	if [ -d "$FORK_INSTALL" ]; then mv "$FORK_INSTALL" "$keep"; fi
	mv "$STAGED" "$FORK_INSTALL"
	if ! version="$(version_of "$FORK_INSTALL")"; then
		reject="$(free_path "$FORK_INSTALL.rejected-$(fork_stamp)")"
		mv "$FORK_INSTALL" "$reject"
		if [ -d "$keep" ]; then mv "$keep" "$FORK_INSTALL"; fi
		fork_status rolled-back "the new build does not run ($version); it is $reject, and $(version_of "$FORK_INSTALL") is installed again"
		exit 1
	fi
	fork_status installed "$version in $FORK_INSTALL (the build before: $keep)"
	log "installed: $version in $FORK_INSTALL"
}

rollback() {
	local newest reject version
	newest="$(ls -d "$FORK_HOME"/pi-bolt-linux-x64.keep-* 2>/dev/null | sort | tail -1 || true)"
	[ -n "$newest" ] || fail "no kept build to go back to ($FORK_HOME/pi-bolt-linux-x64.keep-*)"
	[ -x "$newest/pi" ] || fail "$newest has no executable"
	version="$(version_of "$newest")" || fail "$newest does not run: $version"
	reject="$(free_path "$FORK_INSTALL.rejected-$(fork_stamp)")"
	if [ -d "$FORK_INSTALL" ]; then mv "$FORK_INSTALL" "$reject"; fi
	mv "$newest" "$FORK_INSTALL"
	if ! version="$(version_of "$FORK_INSTALL")"; then
		mv "$FORK_INSTALL" "$(free_path "$FORK_INSTALL.rejected-$(fork_stamp)")"
		mv "$reject" "$FORK_INSTALL"
		fail "$newest does not run once it is in place ($version); $(version_of "$FORK_INSTALL") is installed again"
	fi
	fork_status rolled-back "$version in $FORK_INSTALL (from $newest; the build it replaces is $reject)"
	log "rolled back: $version in $FORK_INSTALL"
}

if [ -n "$ROLLBACK" ]; then rollback; else install_staged; fi
