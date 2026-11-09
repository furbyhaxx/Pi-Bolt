# shellcheck shell=bash
# Shared helpers for scripts/fork: the checkout and install locations, the status file and log the timer writes, and the
# report the four scripts leave behind. Sourced, not run. No bash 4 features: these run under a systemd user unit and from
# a login shell alike.
set -euo pipefail

FORK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The installation the fork build goes into: the installer's own ($PIBOLT_INSTALL in install.sh), named as the release is.
FORK_HOME="${PIBOLT_HOME:-$HOME/.pi-bolt}"
FORK_INSTALL="$FORK_HOME/pi-bolt-linux-x64"
FORK_BRANCH="fork/carry"
FORK_REMOTE="origin"
FORK_UPSTREAM="upstream/pi-bolt"
# Not XDG data: what the timer did last, for a human and for `pi-bolt update` to read.
FORK_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/pi-bolt-fork"
FORK_STATUS="$FORK_STATE/status.json"
FORK_LOG="$FORK_STATE/fork.log"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
	printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
	exit 1
}
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed"; }

fork_branch() { git -C "$FORK_ROOT" symbolic-ref --short -q HEAD 2>/dev/null || true; }
fork_commit() { git -C "$FORK_ROOT" rev-parse HEAD 2>/dev/null || true; }
fork_version() { cat "$FORK_ROOT/VERSION" 2>/dev/null || true; }
# YYYYmmdd-HHMMSS, the stamp of the kept and rejected builds.
fork_stamp() { date +%Y%m%d-%H%M%S; }

# Only linux-x64 is built here: the release's engine is what the fork reuses, and the kit and installation names carry the
# platform.
fork_require_linux_x64() {
	case "$(uname -s)/$(uname -m)" in
	Linux/x86_64 | Linux/amd64) ;;
	*) die "unsupported platform $(uname -s)/$(uname -m): these scripts build and install linux-x64 only" ;;
	esac
}

sha256_file() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# free_path PATH: PATH, or PATH-1, PATH-2, ...: the first that does not exist (a kept or rejected build is never overwritten).
free_path() {
	local path="$1" n=0
	while [ -e "$path" ]; do
		n=$((n + 1))
		path="$1-$n"
	done
	printf '%s\n' "$path"
}
# fork_status STATE [DETAIL]: the report every script leaves -- status.json, a line in the log, a desktop notification.
# DETAIL may run over several lines; it is what a human needs to know, so it goes into the JSON as it is.
fork_status() {
	local state="$1" detail="${2:-}"
	mkdir -p "$FORK_STATE"
	REPORT_STATE="$state" REPORT_DETAIL="$detail" REPORT_COMMIT="$(fork_commit)" REPORT_VERSION="$(fork_version)" \
		REPORT_OUT="$FORK_STATUS" python3 - <<'PY'
import datetime, json, os
report = {
	"state": os.environ["REPORT_STATE"],
	"at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
	"upstreamVersion": os.environ["REPORT_VERSION"],
	"commit": os.environ["REPORT_COMMIT"],
	"detail": os.environ["REPORT_DETAIL"],
}
out = os.environ["REPORT_OUT"]
with open(out + ".tmp", "w") as fh:
	json.dump(report, fh, indent="\t")
	fh.write("\n")
os.replace(out + ".tmp", out)
PY
	printf '%s %s: %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$state" "$(printf '%s' "$detail" | tr '\n' ' ')" >>"$FORK_LOG"
	# (A daily "nothing to do" needs no desktop notification.)
	[ "$state" = up-to-date ] && return 0
	if command -v notify-send >/dev/null 2>&1; then
		notify-send --app-name="Pi-Bolt fork" "Pi-Bolt fork: $state" "$detail" >/dev/null 2>&1 || true
	fi
}

# fork_json_value FILE KEY: a string field of a JSON file (empty when the file or field is absent).
fork_json_value() {
	python3 -c 'import json, sys
try:
	value = json.load(open(sys.argv[1])).get(sys.argv[2], "")
except (OSError, ValueError) as error:
	raise SystemExit(1)
print(value if isinstance(value, str) else "")' "$1" "$2" 2>/dev/null || true
}
