#!/usr/bin/env bash
# The fork's update: sync.sh (merge upstream/pi-bolt into fork/carry and push it), rebuild.sh (build the merge in out/),
# install.sh (swap it into the installation). What fork-build.json's updateCommand names, so `pi-bolt update` runs it.
#
# Usage: update.sh [--no-gate] [--no-push]      (both go to sync.sh)
#
# Stops at the first failure with that step's exit code (2: merge conflict, 3: merged but the smoke gate failed).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib.sh"

"$HERE/sync.sh" "$@"
"$HERE/rebuild.sh"
"$HERE/install.sh"
