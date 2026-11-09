# Fork Builds

A fork build is Pi-Bolt built from a fork of the repository: upstream's release plus local patches. Its installation folder holds `fork-build.json` beside `pi-bolt.txt`, written by the fork's rebuild script. With that marker, `pi-bolt update` and `pi-bolt compile` resolve against the fork instead of upstream's release. Without it, the build is an ordinary upstream build and nothing below applies.

## The marker

The marker is in the build's own folder, not the installation folder around it: `~/.pi-bolt/pi-bolt-linux-x64/fork-build.json`.

```json
{
  "schema": 1,
  "fork": "furbyhaxx/Pi-Bolt",
  "branch": "fork/carry",
  "commit": "f22941d563ab",
  "upstreamVersion": "1.1.7",
  "builtAt": "2026-11-09T09:00:00.000Z",
  "checkout": "/home/me/Pi-Bolt",
  "updateCommand": ["/home/me/Pi-Bolt/scripts/fork/update.sh"],
  "kit": "/home/me/Pi-Bolt/out/kit/pi-bolt-kit-linux-x64.tar.gz",
  "runtime": "/home/me/Pi-Bolt/.work/runtime/bun"
}
```

| Field | Meaning |
|---|---|
| `schema` | `1`. Any other value is an error, not an upstream build |
| `fork`, `branch`, `commit` | Where the build comes from; shown by `pi-bolt --version` and `pi-bolt doctor` |
| `upstreamVersion` | The upstream release the patches are applied to |
| `checkout` | The checkout `updateCommand` runs in |
| `updateCommand` | The command that merges upstream and rebuilds, as an argument list (never a shell string) |
| `kit`, `runtime` | What `pi-bolt compile` builds with |

A marker that is there but unreadable, not JSON, or of an unknown schema stops the commands below with an error naming the file. A fork build is never silently taken for upstream's.

## Updating

`pi-bolt update` runs `updateCommand` in `checkout` with the terminal's stdin and output, and exits with its exit code. One line first says which command runs, that it merges upstream and rebuilds, and that `--upstream` installs upstream's release instead.

`pi-bolt update --upstream` keeps the old behavior: the release installer fetches and installs upstream's release, and the fork's patches are gone until the fork is rebuilt.

`--extensions`, `--models`, `--rollback`, `--channel` and Windows installs are unchanged.

## Compiling

`pi-bolt compile` builds with the marker's `kit` and `runtime` unless `--kit` and `--runtime` are given: the release's own kit would build upstream's Pi, without the patches. A kit or runtime file that is gone fails before anything is built, naming the file and the update command that rebuilds it. Explicit flags always win.

The new build keeps the marker: a compile copies the build folder's other files beside the new executable.

## Rebuilding

Run the marker's `updateCommand` yourself, or `pi-bolt update`, which runs it for you.

## Seeing that a build is a fork's

`pi-bolt --version` prints a second line, and `pi-bolt doctor` a row:

```
fork build: furbyhaxx/Pi-Bolt fork/carry@f22941d (upstream 1.1.7)
```

The update notice adds that `pi-bolt update` merges upstream and rebuilds the fork build.
