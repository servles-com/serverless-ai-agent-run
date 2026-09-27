# serverless-ai-agent-run

Run an AI coding agent (OpenCode first; Claude Code / Codex / custom later) as a
**fire-and-forget job behind an HTTP API**, like a Cloudflare Worker: `POST` a task
plus inputs, get a `run_id`, receive progress on a webhook, pick up the result and
artifacts. Every run executes in a fresh, isolated, disposable container (an
**Operating Room**) on one VM, and every failure ends with a machine-readable
diagnosis.

It is not literally serverless: it's one VM running Docker + gVisor. From the
caller's side it behaves like serverless.

> Status: **V0 lab**. Single operator (one API token), one VM, free models via
> OpenRouter. See [docs/ROADMAP.md](docs/ROADMAP.md) and
> [docs/requirements-log.md](docs/requirements-log.md).

## Why this exists

The environment is only as good as its ability to debug itself. Free models fail
constantly — rate limits, hangs, loops, "done!" with nothing produced. V0 is
built to **catch and classify** those failures (`diagnosis.category`), not to
hide them. The dogfood loop runs real tasks on free models every 3 hours and
reports which failure classes are growing.

## API

All endpoints except `/healthz` need `Authorization: Bearer $SAR_API_TOKEN`.

```http
POST /runs                        → 202 {id, state, links}
GET  /runs                        recent runs
GET  /runs/{id}                   state, result, diagnosis
GET  /runs/{id}/events            JSON; ?after=<seq>; SSE with ?follow=1
GET  /runs/{id}/debug             everything needed to understand a failure
GET  /runs/{id}/artifacts         list
GET  /runs/{id}/artifacts/{path}  download
POST /runs/{id}/cancel
GET  /healthz
```

Create a run:

```json
{
  "agent": "opencode",
  "task": "Fix the failing test in calc.py and put the fixed file in /artifacts",
  "model": "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
  "files": { "calc.py": "..." },
  "repo": { "url": "https://github.com/org/repo", "ref": "main" },
  "secrets": ["GITHUB_TOKEN"],
  "webhook": { "url": "https://you.example/hook", "secret": "hmac-key", "agent_events": false },
  "limits": { "timeout_s": 900, "idle_timeout_s": 240, "memory_mb": 1024, "cpus": 1, "pids": 512 }
}
```

Only `task` is required. `agent: "shell"` runs `task` as a shell script — used by
the test suites to inject exact failures.

Inside the room: `/workspace` (files + repo clone), `/artifacts` (exported
result), non-root user, no capabilities, gVisor kernel, internet yes,
metadata/host/private networks no.

Webhook: each lifecycle event is POSTed as JSON, in order, signed with
`X-SAR-Signature: sha256=HMAC(secret, body)`. The last one is `run.completed`.
Agent events (tool calls, text) are sent only with `agent_events: true`.

### Run states and diagnosis

`QUEUED → PREPARING → RUNNING → EXPORTING → SUCCEEDED | FAILED | CANCELLED | TIMED_OUT`

Every non-success has `diagnosis = {category, summary, evidence[], retryable, hints[]}`:

| category | meaning |
|---|---|
| `ROOM_START_FAILED` | docker/gVisor could not start the room |
| `HYDRATE_FAILED` | repo clone / input files failed |
| `MODEL_RATE_LIMITED` `MODEL_NOT_FOUND` `MODEL_AUTH_FAILED` `MODEL_CONTEXT_OVERFLOW` `MODEL_PROVIDER_ERROR` | provider side — not the agent's fault |
| `TIMEOUT` | exceeded `timeout_s` |
| `IDLE_STALL` | no output for `idle_timeout_s` — hung model call or interactive command |
| `OOM_KILLED` | hit `memory_mb` |
| `AGENT_CRASHED` / `AGENT_BINARY_MISSING` | agent process exit ≠ 0 / not in image |
| `AGENT_NO_OUTPUT` / `AGENT_EMPTY_RESULT` | exited 0 but produced nothing |
| `ORPHANED_BY_RESTART` | service restarted mid-run |
| `RUNTIME_BUG` | bug in this service |

Classifier: [src/failures.ts](src/failures.ts). Dogfood adds `SILENT_FAILURE`
(state `SUCCEEDED` but zero artifacts).

## Run on a VM

```bash
# fresh Ubuntu 24.04, as root — installs docker, gVisor, node 24, builds the room image,
# enables systemd units (API, network policy, dogfood timer)
curl -fsSL https://raw.githubusercontent.com/servles-com/serverless-ai-agent-run/main/scripts/vm-bootstrap.sh | sudo bash
sudoedit /etc/sar/secrets.env      # OPENROUTER_API_KEY=..., optionally GITHUB_TOKEN=...
sudo systemctl restart sar
sudo -u sar bash /opt/sar/scripts/selftest.sh             # must print SELFTEST PASSED
sudo -u sar SAR_LIVE=1 bash /opt/sar/scripts/selftest.sh  # + one live opencode run
```

The API listens on `127.0.0.1:8787`; reach it via SSH tunnel
(`bash scripts/gcp-lab-vm.sh tunnel`) until there is a proper ingress.

GCP lab helper: `scripts/gcp-lab-vm.sh create|bootstrap|ssh|tunnel|delete`.

## Local development

```bash
npm install --include=dev
npm run typecheck && npm run test:unit
docker build -t sar-room-opencode room-image
docker network create sar-rooms
SAR_INSECURE_DEV=1 OPENROUTER_API_KEY=... npm start     # runc instead of gVisor locally
npm run test:e2e
```

## Layout

```text
src/server.ts        HTTP API
src/runner.ts        Run Manager: queue, hydrate → execute → export → sterilize, crash recovery
src/rooms.ts         Room Manager: docker/gVisor container, limits, timeouts, teardown
src/failures.ts      failure classifier (pure function)
src/webhooks.ts      signed, ordered webhook delivery
src/adapters/        opencode (JSON event stream) and shell (tests)
src/store.ts         run registry on disk: runs/<id>/{run.json,events.jsonl,workspace,artifacts,room/}
room-image/          Operating Room image (node + opencode + git + python)
scripts/             vm-bootstrap, room-network-policy, selftest, dogfood, gcp-lab-vm
deploy/              systemd units, secrets example
tests/unit           classifier
tests/e2e            failure modes, isolation probes, live opencode
tests/dogfood        task set for the dogfood loop
docs/                architecture, security, roadmap, requirements log, review
```

## Terminology

**Run** — one execution request. **Operating Room / Room** — isolated ephemeral
container created for one run. **Control Plane** — this API + run manager
(trusted, on the host). **Persistent Plane** — durable data; in V0 simply the
run directory on the VM disk, GCS later.

## Claude Code Instructions

- Keep V0 minimal. Requirements come from the task (API + webhook, isolated rooms,
  failure diagnosis), not from the earlier multi-tenant draft. Tenants, storage
  gateway, KMS and similar access-control layers are **later**, see ROADMAP.
- Node ≥ 23.6 runs `.ts` directly (type stripping) — no build step. Use only
  erasable TypeScript syntax (no enums, no parameter properties). No runtime deps.
- Every new failure you observe must get a category in `src/failures.ts` plus a
  unit test in `tests/unit/failures.test.ts`, and, if reproducible with the shell
  agent, an e2e case in `tests/e2e/failure-modes.test.ts`.
- Room isolation changes must keep `tests/e2e/isolation.test.ts` green on the VM
  with `SAR_ROOM_RUNTIME=runsc`.
- Debug a run: `GET /runs/{id}/debug`, or on the VM
  `/var/lib/sar/runs/<id>/{run.json,diagnosis.json,events.jsonl,room/stderr.log,room/docker-args.json}`.
- Keep `docs/requirements-log.md` current.
- PR flow: feature branch → PR → CI green → merge. Never push to `main` directly.
