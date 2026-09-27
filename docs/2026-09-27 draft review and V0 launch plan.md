# Draft review and V0 launch plan — 2026-09-27

Review of the initial design draft (README / ARCHITECTURE / SECURITY / ROADMAP as
imported in the first commit) against what the product actually needs for V0,
and what was changed.

## What the product needs (from the task)

1. Fire-and-forget API: submit task + inputs, get `run_id`, don't hold a connection.
2. Updates via **webhook** subscription (and pull/SSE for debugging).
3. Results + artifacts back.
4. Optional access to GitHub / the caller's credentials.
5. Each run isolated in its own container on one VM.
6. **Debuggability first**: the environment must catch and explain agent failures —
   free models will fail a lot, and those failures are the data we want.
7. As much as possible self-testing / self-running (dogfood loop).

## Verdict on the draft

Good: lifecycle `hydrate → execute → export → sterilize`, "room is never the source
of truth", explicit terminal states, teardown on every terminal state, gVisor as
target runtime, "no single layer is sufficient", deterministic tests over LLM
adversary, API returns `run_id` instead of holding the request.

Gaps against the task:

| # | Issue | Change |
|---|---|---|
| 1 | No webhooks at all — only pull events. That's the primary integration for the caller. | Signed (HMAC), ordered webhook delivery with retries; failures recorded as `webhook.failed` in the run's own log. |
| 2 | No failure taxonomy. States say *that* a run failed, never *why*. That's the core of "the environment is as good as it debugs itself". | `diagnosis {category, summary, evidence, retryable, hints}` from a pure classifier, 17 categories, unit-tested. `GET /runs/{id}/debug` bundle. |
| 3 | V0 scope is dominated by multi-tenant access control: tenant resolution, storage gateway `room→run→tenant→namespace`, fake object store, KMS, adversarial LLM tenant-theft. For a single-operator lab this is the most expensive kind of premature complexity (every permission check spreads through all call paths). | V0 = one API token, one operator. Rooms stay strongly isolated (protects the **host**, costs only docker flags + gVisor). Tenants / storage gateway / KMS moved to later milestones, driven by the first real multi-user need. |
| 4 | "Local fake persistent storage first" is an extra abstraction with no consumer. | The run directory *is* the persistent plane in V0 (bind-mounted `/workspace`, `/artifacts`). GCS later. |
| 5 | No crash recovery: what happens to RUNNING runs if the service restarts? | On startup: orphan containers destroyed, non-terminal runs → `FAILED/ORPHANED_BY_RESTART`. |
| 6 | No hang detection — the most common free-model failure. | `idle_timeout_s` (no output) separate from `timeout_s`. |
| 7 | `AUTH_REQUIRED` state has no flow behind it. | Removed; unknown secret names rejected at submit time. |
| 8 | Lab host 1 vCPU / 1 GB: opencode (node) + image build in 1 GB will OOM. | Bootstrap adds 2 GB swap on small hosts; lab VM is e2-small (2 GB). |
| 9 | gVisor + docker user-defined network: gVisor netstack bypasses docker's embedded DNS (127.0.0.11). | Rooms get explicit `--dns`. To be confirmed on the VM. |
| 10 | Provider API key (OpenRouter) is injected into the room — a hostile agent can read it. Draft's "capability gateway" solves it but is heavy. | Accepted for V0 (free-tier key). Next step: tiny host-side LLM proxy that holds the key; room gets a per-run token. |
| 11 | No self-driving loop. | Dogfood timer every 3h on free models → reports + `history.jsonl`; `selftest.sh` for every deploy. |

## V0 launch sequence

1. `scripts/gcp-lab-vm.sh create` — e2-small, Ubuntu 24.04 (temporary, Maryam's GCP credits).
2. `vm-bootstrap.sh` — docker, gVisor (`runsc`), node 24, room image, systemd units, network policy.
3. Put `OPENROUTER_API_KEY` into `/etc/sar/secrets.env`.
4. `selftest.sh` — unit + failure modes + isolation probes must pass.
5. `SAR_LIVE=1 selftest.sh` — one live opencode run on a free model ends in a *diagnosed* state.
6. Dogfood timer runs; read `/var/lib/sar/reports/`.

## Next steps (self-driving)

1. **Failure → issue automation**: dogfood job files a GitHub issue for every new
   `SILENT_FAILURE` / `RUNTIME_BUG` / unclassified pattern, with the `/debug` bundle attached.
2. **Self-fix loop**: issues labelled `auto` get picked up by an opencode session
   (Session Manager) → PR → CI (unit tests + selftest on the VM) → human merge.
3. **CI on the VM**: GitHub Actions self-hosted runner on the lab VM runs `selftest.sh` per PR.
4. Host-side LLM proxy (removes provider key from rooms, gives per-run token accounting and
   precise `MODEL_*` classification from real HTTP status codes instead of log regexes).
5. `POST /runs/{id}/messages` — continue a session (opencode `--session`).
6. Adapters: Claude Code, Codex.
7. GCS export, then multi-tenant — only when there is a second real user.
