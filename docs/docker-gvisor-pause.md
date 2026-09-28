# Docker/gVisor rooms: how they worked, why they are paused, how to bring them back

Date: 2026-09-28. The last commit with the working Docker/gVisor execution path is
**`04afa47`** (main, "Roadmap: 1b done on the SAR side"). Nothing was lost: every file
listed below can be restored from it.

## Why paused

- **Two machines, one job.** SAR ran on its own VM only to host the rooms; the agents
  it was meant to isolate (trained-assist) run on the main GCP VM. Paying for the second
  VM bought isolation for dogfood runs, not for the real traffic.
- **trained-assist already isolates its runs** with slots + per-profile ACL. For the
  current users that is enough; a second isolation layer inside SAR duplicated it.
- **What SAR is actually used for** is the API contract: `POST /runs`, webhooks with
  HMAC, the diagnosis on every failure, streaming, batches. That part stays; only the
  executor changed (`src/agent-proxy.ts` → trained-assist-agent `POST /web/run-bearer`).

## How it worked

```text
POST /runs → queue (SAR_MAX_ROOMS) → hydrate (git clone with the token in a header, input files
→ runs/<id>/workspace) → docker run --runtime runsc … → stdout JSON events of opencode →
events.jsonl → docker inspect (exit code, OOMKilled) → docker rm -f → classifier
```

**The room** (`src/rooms.ts`), one container per run, destroyed afterwards:

| what | how |
|---|---|
| kernel isolation | gVisor: `--runtime runsc` (`SAR_ROOM_RUNTIME=runsc`; empty = runc for local Docker Desktop) |
| user | non-root: `--user <service uid:gid>`, so bind-mounted dirs stay writable |
| privileges | `--cap-drop ALL`, `--security-opt no-new-privileges`, `--init` |
| limits | `--memory`/`--memory-swap` = `memory_mb`, `--cpus`, `--pids-limit`, `--tmpfs /tmp:size=512m` |
| files | `-v runs/<id>/workspace:/workspace`, `-v runs/<id>/artifacts:/artifacts`, workdir `/workspace` |
| secrets | `-e NAME` without a value; the value comes from the child env, so it never shows in `ps` |
| DNS | own `resolv.conf` bind-mounted read-only: gVisor's netstack cannot reach docker's embedded `127.0.0.11` |
| watchdogs | hard timeout (`timeout_s`) and idle timeout (`idle_timeout_s` without stdout/stderr) → `docker kill` |
| labels | `sar.room=1`, `sar.run=<id>`, `sar.instance=<instance>`: orphans of this instance reaped on start |
| evidence | `room/docker-args.json`, `stdout.log`, `stderr.log`, `inspect.json` per run |

**Network** (`scripts/room-network-policy.sh`, systemd `sar-netpolicy.service`): bridge
`sar-rooms`/`sar0` with ICC off (rooms cannot see each other); a `DOCKER-USER` chain
rejects 169.254/16 (metadata), 10/8, 172.16/12, 192.168/16, 100.64/10; `INPUT` from
`sar0` rejected (no host API, no sshd). Internet stays open for model APIs, git, npm.
Every "X unreachable" probe in `tests/e2e/isolation.test.ts` had a paired "Y reachable".

**Image** (`room-image/Dockerfile`): `node:22-bookworm-slim` + git, python3, ripgrep, jq;
`opencode-ai@1.18.32` with a pre-warmed provider cache; world-writable `HOME`.

**Agent adapters** (`src/adapters/`): `opencode` (JSON event stream, `ladder/free`
model through the owner's LLM ladder, live mode via `opencode-live.mjs` wrapper with
text deltas), `shell` (deterministic tests). `src/step-timing.ts` split model wait vs
tool time; fail-fast stopped a room after N provider errors in a row.

**Host-side PRs** (`src/pullrequest.ts`, `src/deliverables.ts`): the host, never the
room, diffed the workspace, committed and opened the PR with `SAR_GITHUB_PUSH_TOKEN`.

**Machine** (`scripts/vm-bootstrap.sh`, `machine.sh`, `gcp-lab-vm.sh`): Ubuntu 24.04,
docker, gVisor from `storage.googleapis.com/gvisor/releases` + `runsc install`,
node 24, image build, systemd units. `scripts/selftest.sh` + `selftest-candidate.sh`
and the `selftest-vm` workflow (self-hosted runner, `ci-runner-setup.sh`) ran 13 failure
modes and 11 isolation probes against every PR.

## How to bring it back

```bash
git checkout 04afa47 -- src/rooms.ts src/adapters src/run-env.ts src/deliverables.ts \
  src/pullrequest.ts src/step-timing.ts room-image scripts/vm-bootstrap.sh scripts/machine.sh \
  scripts/gcp-lab-vm.sh scripts/selftest.sh scripts/selftest-candidate.sh scripts/room-network-policy.sh \
  scripts/ci-runner-setup.sh deploy/sar-netpolicy.service deploy/secrets.env.example \
  tests/e2e .github/workflows/selftest-vm.yml \
  tests/unit/rooms.test.ts tests/unit/opencode-live.test.ts tests/unit/step-timing.test.ts \
  tests/unit/models-ladder.test.ts tests/unit/pullrequest.test.ts tests/unit/creds-wiring.test.ts
```

Then either revert the proxy commit, or (better, phase 3 of the migration plan) make the
executor a per-run choice: `runner.ts` calls `startRoom()` for runs that need a full
sandbox and `runOnAgent()` for the rest — both already return "a handle with `done` and
`cancel`", which is all `queue.ts` needs. Before relying on it again: bootstrap a machine
(`SAR_SSH=… bash scripts/machine.sh bootstrap`), run `scripts/selftest.sh`, and re-add
`selftest-vm` to the required checks of `main`.
