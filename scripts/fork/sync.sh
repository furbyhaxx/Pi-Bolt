#!/usr/bin/env bash
# Brings fork/carry up to date with origin (other hosts push it too) and with upstream/pi-bolt: merges (never rebases),
# runs the smoke gate on the merge, pushes the branch to origin, also when only a hand-resolved merge is waiting. A conflict is left for a human to resolve: the merge is aborted and nothing is pushed.
#
# Usage: sync.sh [--no-gate] [--no-push]
#   --no-gate  merge without running the smoke gate (a machine without node_modules, or a merge-only run)
#   --no-push  merge without pushing fork/carry to origin
#
# Exit: 0 up to date or merged (and pushed), 1 refused or failed, 2 merge conflict, 3 merged but the gate failed,
#       4 merged but the push failed. Every outcome is in ${XDG_STATE_HOME:-$HOME/.local/state}/pi-bolt-fork/status.json.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib.sh"

# The smoke gate after a merge: one vitest run per file, from packages/coding-agent, then the type check `npm run check`
# runs. The patch's tests are the projection ones; test/fork-build.test.ts guards the fork-build marker (skipped with a
# warning while it is not in the tree). One list, in one place: a new test the patch needs belongs here.
GATE_TESTS='test/transcript-projection.test.ts
test/transcript-span-component.test.ts
test/transcript-projection-controller.test.ts
test/extensions-transcript-projection.test.ts
test/interactive-mode-transcript-projection.test.ts
test/examples-transcript-projection.test.ts
test/pi-bolt-fork-build.test.ts'
GATE_LOG="$FORK_STATE/smoke-gate.log"

NO_GATE=""
NO_PUSH=""
while [ $# -gt 0 ]; do
	case "$1" in
	--no-gate) NO_GATE=1 ;;
	--no-push) NO_PUSH=1 ;;
	-h | --help) sed -n '2,11p' "$0"; exit 0 ;;
	*) die "unknown option $1" ;;
	esac
	shift
done
need git

refuse() {
	fork_status refused "$1"
	exit 1
}

require_branch() {
	local branch
	branch="$(fork_branch)"
	[ "$branch" = "$FORK_BRANCH" ] || refuse "not on $FORK_BRANCH (on ${branch:-no branch}): these scripts merge into $FORK_BRANCH only"
}

require_clean() {
	local dirty
	dirty="$(git -C "$FORK_ROOT" status --porcelain)"
	[ -z "$dirty" ] || refuse "the checkout has uncommitted work, which a merge would take with it:
$dirty"
}

# smoke_gate: the model catalog modules, the patch's tests, and the type check, on the merged tree. Prints what failed; 0
# when everything passed.
smoke_gate() {
	local agent="$FORK_ROOT/packages/coding-agent" vitest="$FORK_ROOT/node_modules/vitest/dist/cli.js" tsc="$FORK_ROOT/node_modules/typescript/bin/tsc"
	local test failed=""
	mkdir -p "$FORK_STATE"
	: >"$GATE_LOG"
	if [ ! -f "$vitest" ] || [ ! -f "$tsc" ]; then
		printf 'no node_modules in %s: run scripts/prepare-pi.sh first\n' "$FORK_ROOT"
		return 1
	fi
	# First, because Pi imports them: `npm run check` generates them too. They are written into packages/ai/src/providers
	# (gitignored), and a fresh checkout has none.
	log "smoke gate: the model catalog modules"
	(cd "$FORK_ROOT/packages/ai" && node scripts/generate-catalog-modules.ts) >>"$GATE_LOG" 2>&1 || failed="$failed
npm run generate:catalog-modules"
	for test in $GATE_TESTS; do
		if [ ! -f "$agent/$test" ]; then
			warn "smoke gate: $test is not in this tree, skipped"
			continue
		fi
		log "smoke gate: $test"
		if ! (cd "$agent" && node "$vitest" --run "$test") >>"$GATE_LOG" 2>&1; then
			failed="$failed
$test"
		fi
	done
	# The type check of `npm run check` (its other steps rewrite files: a gate does not).
	log "smoke gate: the type check (tsc --noEmit)"
	if ! (cd "$FORK_ROOT" && node "$tsc" --noEmit) >>"$GATE_LOG" 2>&1; then
		failed="$failed
tsc --noEmit"
	fi
	[ -z "$failed" ] || printf 'the smoke gate failed:%s\n' "$failed"
	[ -z "$failed" ]
}

main() {
	local conflicts commit push_out gate_report
	require_branch
	require_clean
	log "fetching upstream (${FORK_UPSTREAM%%/*}) in $FORK_ROOT"
	git -C "$FORK_ROOT" fetch --quiet "${FORK_UPSTREAM%%/*}" || refuse "git fetch failed"
	git -C "$FORK_ROOT" fetch --quiet "$FORK_REMOTE" || refuse "git fetch $FORK_REMOTE failed"

	local merged="" source
	for source in "$FORK_REMOTE/$FORK_BRANCH" "$FORK_UPSTREAM"; do
		git -C "$FORK_ROOT" rev-parse --verify --quiet "$source" >/dev/null || continue
		git -C "$FORK_ROOT" merge-base --is-ancestor "$source" HEAD && continue
		log "merging $source into $FORK_BRANCH"
		if ! git -C "$FORK_ROOT" merge --no-edit "$source"; then
			conflicts="$(git -C "$FORK_ROOT" diff --name-only --diff-filter=U)"
			git -C "$FORK_ROOT" merge --abort 2>/dev/null || warn "git merge --abort could not undo the merge: resolve it by hand"
			fork_status conflict "the merge of $source stopped on these files, and was aborted:
$conflicts
Resolve it by hand: git merge $source, fix the files, commit, then scripts/fork/update.sh."
			return 2
		fi
		merged=1
	done
	commit="$(git -C "$FORK_ROOT" rev-parse --short HEAD)"

	if [ -z "$merged" ]; then
		if git -C "$FORK_ROOT" merge-base --is-ancestor HEAD "$FORK_REMOTE/$FORK_BRANCH" 2>/dev/null; then
			fork_status up-to-date "$FORK_UPSTREAM and $FORK_REMOTE/$FORK_BRANCH are already in $FORK_BRANCH ($commit)"
			log "up to date: nothing to merge or push"
			return 0
		fi
		log "nothing to merge, but $FORK_BRANCH ($commit) is ahead of $FORK_REMOTE: gate and push it"
	fi

	if [ -z "$NO_GATE" ]; then
		if ! gate_report="$(smoke_gate)"; then
			fork_status merged-but-failing "$FORK_BRANCH at $commit, and the smoke gate failed:
$gate_report
The merge is kept. The whole gate output: $GATE_LOG"
			return 3
		fi
	fi

	if [ -n "$NO_PUSH" ]; then
		fork_status merged "$FORK_BRANCH at $commit; not pushed (--no-push)"
		log "merged $commit, not pushed (--no-push)"
		return 0
	fi
	log "pushing $FORK_BRANCH to $FORK_REMOTE"
	if ! push_out="$(git -C "$FORK_ROOT" push "$FORK_REMOTE" "HEAD:refs/heads/$FORK_BRANCH" 2>&1)"; then
		fork_status merged-not-pushed "$FORK_BRANCH at $commit, but the push to $FORK_REMOTE failed:
$push_out"
		return 4
	fi
	fork_status merged "$FORK_BRANCH at $commit, pushed to $FORK_REMOTE"
	return 0
}

main
