# Fork build: automated catch-up and local rebuild

The fork — upstream `opensec-git/Pi-Bolt` `upstream/pi-bolt` plus the transcript-projection patch, on `fork/carry` — is
kept current and rebuilt locally. No runner, no signing, no release: upstream already publishes the engine runtime, and
only the JavaScript layer is built here.

```
sync.sh      git fetch upstream; merge upstream/pi-bolt into fork/carry (merge, never rebase)
             smoke gate on the merge (the patch's tests + the type check); push fork/carry to origin
rebuild.sh   runtime (reused) -> Pi's packages -> driver + kit -> `pi compile` with the installed extension list
             -> verify -> out/pi-bolt-compiled + fork-build.json (installed: nothing)
install.sh   swap out/pi-bolt-compiled into the installation, keeping the build it replaces
```

`update.sh` runs the three in that order and stops at the first failure with its exit code. It is what
`fork-build.json`'s `updateCommand` names, so `pi-bolt update` on a fork build runs it.

## Commands

| Command | What it does |
|---|---|
| `scripts/fork/update.sh` | sync, rebuild, install |
| `scripts/fork/sync.sh [--no-gate] [--no-push]` | merge and push only (`--no-gate`: no tests; `--no-push`: no push) |
| `scripts/fork/rebuild.sh` | build `out/pi-bolt-compiled`, install nothing |
| `scripts/fork/install.sh` | install the staged build |
| `scripts/fork/install.sh --rollback` | put the newest kept build back |
| `scripts/fork/install-timer.sh [--enable]` | render the systemd user units into `~/.config/systemd/user` |

Environment: `PIBOLT_HOME` (default `$HOME/.pi-bolt`) holds the installation, `compile.json` and the installer's `cache`.
`XDG_STATE_HOME` (default `$HOME/.local/state`) holds `pi-bolt-fork/status.json` and `pi-bolt-fork/fork.log`.

## Statuses

`${XDG_STATE_HOME:-$HOME/.local/state}/pi-bolt-fork/status.json` — `{state, at, upstreamVersion, commit, detail}` — and one
line per run in `fork.log` in the same folder. A desktop notification goes out where `notify-send` is.

| state | exit | meaning |
|---|---|---|
| `up-to-date` | 0 | `upstream/pi-bolt` is already an ancestor of `fork/carry` |
| `merged` | 0 | merged and pushed (or `--no-push`) |
| `refused` | 1 | the checkout is dirty or not on `fork/carry`; nothing was done |
| `conflict` | 2 | the merge conflicted, and was aborted; resolve by hand |
| `merged-but-failing` | 3 | merged, but the smoke gate failed; the merge is kept |
| `merged-not-pushed` | 4 | merged, the push failed |
| `staged` | 0 | `out/pi-bolt-compiled` is built and verified |
| `failed` | 1 | a step failed; `detail` says which |
| `installed` | 0 | the staged build is in place |
| `rolled-back` | 1 | the new build did not run and the previous one is installed again |

The systemd unit fails for `conflict`, `merged-but-failing` and `failed`, so `systemctl --user status` shows it.

## Conflict

`sync.sh` aborts the merge, writes the conflicted files into `status.json` and exits 2. Resolve it like any merge:

```
git -C <checkout> merge upstream/pi-bolt     # the merge is not left half-done: this repeats it
# fix the files, git add them
git commit --no-edit
scripts/fork/update.sh                        # or rebuild.sh && install.sh, if the push is not wanted
```

## Install and rollback

`install.sh` refuses unless `out/pi-bolt-compiled/fork-build.json` names the checkout's `HEAD` commit: a build of another
commit is not what `fork/carry` is. The build it replaces stays as `pi-bolt-linux-x64.keep-YYYYmmdd-HHMMSS` (an existing
keep folder is never overwritten; `-1`, `-2`, … follows). A build that does not answer `--version` after the swap is
moved to `.rejected-YYYYmmdd-HHMMSS` and the kept one is put back, in the same run. The installer's own
`pi-bolt-linux-x64.previous` — what `pi-bolt update --rollback` swaps — is never touched.

`install.sh --rollback` moves the newest keep folder back and the build it replaces to `.rejected-…`. It goes back one
build, not two: rolling back again would take the build it just rejected. Delete `.rejected-*` folders by hand.

## Timer

`install-timer.sh` renders `systemd/pi-bolt-fork-sync.{service,timer}` with the checkout's path and runs
`systemctl --user daemon-reload`; `--enable` also enables the timer. The timer is daily, `Persistent=true`,
`RandomizedDelaySec=1h`, and it runs `sync.sh` then `rebuild.sh` — never `install.sh`: an install replaces the Pi-Bolt that
is running, which stays a human or agent decision.

A user unit has the manager's `PATH` (`/usr/local/bin:/usr/bin:/bin`), which is enough for git, node, npm, python3 and
tar. A `node` elsewhere: `systemctl --user set-environment PATH=…`.

## fork-build.json

`rebuild.sh` writes it into the build's folder, beside `pi-bolt.txt`; `install.sh` and Pi's own fork-build guard read it.

```json
{
  "schema": 1,
  "fork": "furbyhaxx/Pi-Bolt",
  "branch": "fork/carry",
  "commit": "<full sha>",
  "upstreamVersion": "<VERSION>",
  "builtAt": "<ISO 8601>",
  "checkout": "<abs path of the checkout>",
  "updateCommand": ["<checkout>/scripts/fork/update.sh"],
  "kit": "<checkout>/out/kit/pi-bolt-kit-linux-x64.tar.gz",
  "runtime": "<checkout>/.work/runtime/bun"
}
```

## What this does not do

- No release, no signing, no archive: nothing leaves the machine.
- No GitHub runner and no push but `fork/carry` — `origin/pi-bolt` is a mirror of upstream and is never written.
- linux-x64 only; another platform stops with a message.
- The extensions compiled in are the ones `$PIBOLT_HOME/compile.json` names (the installed build's), never a list in here.
