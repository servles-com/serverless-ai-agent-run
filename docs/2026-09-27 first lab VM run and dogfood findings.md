# First lab VM run and dogfood findings — 2026-09-27

Lab VM: GCP `project-e7960d87-a0b0-406b-a2f` (Maryam's credits), `sar-lab-1`,
e2-small, us-central1-a, Ubuntu 24.04, docker + gVisor `runsc`. Temporary —
delete with `scripts/gcp-lab-vm.sh delete` when moving to the permanent VM.

## Bugs found by the self-test on the real runtime

1. **No DNS in gVisor rooms.** Docker writes `nameserver 127.0.0.11` (embedded DNS)
   for user-defined networks even with `--dns`; gVisor's netstack can't reach it.
   Fix: rooms mount their own `/etc/resolv.conf`. Found by probe `internet_works`.
   Lesson: every "must NOT reach X" probe needs a paired "CAN reach Y" probe,
   otherwise a dead network makes all isolation checks pass vacuously.
2. **Redeploy kept old code** — bootstrap used `enable --now` on an already running
   unit. Fix: explicit restart.

After fixes: `SAR_LIVE=1 selftest.sh` → PASSED (unit 15, failure modes 13, isolation 11/11, live opencode).

## First dogfood batch (12 runs, 2 free models)

| model | OK | failed |
|---|---|---|
| nemotron-3-super-120b-a12b:free | 6/6 (21–74 s) | — |
| nemotron-3.5-lightning:free | 3/6 | 3 × TIMEOUT (600 s, 0 tool calls) |

The 3 timeouts were **misclassified**: stderr showed OpenRouter `stream error`
`code=504` every ~2 min; opencode retried each time, so output never went quiet
long enough for `IDLE_STALL` and the run hit the hard timeout. Now classified as
`MODEL_PROVIDER_ERROR` (state stays `TIMED_OUT`). Next: fail fast after N
consecutive provider errors instead of burning 10 minutes.

No `SILENT_FAILURE` (agent claims success with no artifacts) in this batch.

## Operational notes

- API token: `/etc/sar/sar.env` on the VM; API only on `127.0.0.1:8787` → use `scripts/gcp-lab-vm.sh tunnel`.
- Issue filing from dogfood is wired but inactive until `GH_TOKEN` is set in `/etc/sar/dogfood.env` (not secrets.env — rooms can request those).
- Dogfood timer: every 3 h; reports in `/var/lib/sar/reports/`.

## Burst mode (every 5 min, 2 random runs, 240 s timeout) — first 35 min

19:20–19:55 UTC: 14 runs, 11 OK, 2 TIMEOUT, 1 MODEL_PROVIDER_ERROR.

- The new provider-retry classification fired on real traffic (`big-output`, lightning).
- Remaining TIMEOUTs are genuine: `nemotron-3.5-lightning` spends 60–90 s per model
  step with no provider errors, so 2–3 steps exhaust 240 s. Correct category; a
  useful refinement is to split time into *model wait* vs *tool execution* in the
  evidence, so "slow model" and "slow command" are distinguishable at a glance.
- Traps behaved: `interactive-trap` (npm init) OK — no IDLE_STALL yet; `vague`
  ("Make it better.") produced an artifact, so no SILENT_FAILURE yet.
- `nemotron-3-super` is the reliable one: every run OK, 20–75 s.
- Logs: everything needed was in the run dir; the service journal had no per-run
  lines — added (one line per start/finish).
