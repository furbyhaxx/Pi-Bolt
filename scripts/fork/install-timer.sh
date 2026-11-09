#!/usr/bin/env bash
# Renders the fork's systemd user units (a daily sync and rebuild) into ${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user,
# with this checkout's path in place of @CHECKOUT@, and reloads the user manager. The timer is not enabled unless --enable
# is passed: a scheduled build is a decision.
#
# Usage: install-timer.sh [--enable]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib.sh"

ENABLE=""
case "${1:-}" in
--enable) ENABLE=1 ;;
"") ;;
-h | --help) sed -n '2,7p' "$0"; exit 0 ;;
*) die "unknown option $1" ;;
esac
need systemctl
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
TIMER=pi-bolt-fork-sync.timer

mkdir -p "$UNIT_DIR"
for unit in pi-bolt-fork-sync.service "$TIMER"; do
	sed -e "s|@CHECKOUT@|$FORK_ROOT|g" "$HERE/systemd/$unit" >"$UNIT_DIR/$unit"
	log "wrote $UNIT_DIR/$unit"
done
systemctl --user daemon-reload
log "systemctl --user daemon-reload: the units are in place"
if [ -n "$ENABLE" ]; then
	systemctl --user enable --now "$TIMER"
	log "enabled $TIMER (daily)"
else
	log "not enabled: systemctl --user enable --now $TIMER (or run this script with --enable)"
fi
