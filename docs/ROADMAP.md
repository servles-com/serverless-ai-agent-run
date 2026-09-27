# Roadmap

## V0 — local isolation laboratory

Goal: prove the execution-room model and the failure-diagnosis loop on one VM.
Scope revised 2026-09-27, see `docs/2026-09-27 draft review and V0 launch plan.md`.

- [x] `POST /runs`, `GET /runs/{id}`, events (JSON + SSE), artifacts, cancel
- [x] run state machine + structured events (`events.jsonl`)
- [x] signed webhooks
- [x] failure classifier + `/debug` bundle
- [x] fresh room per run: gVisor, unprivileged, cap-drop, mem/CPU/PID/time/idle limits
- [x] room destroyed after every terminal state; orphan reconciliation on restart
- [x] OpenCode adapter on free models
- [x] deterministic failure-mode + isolation suites (`scripts/selftest.sh`)
- [x] dogfood timer on free models
- [x] selftest green on the lab VM with `runsc` (2026-09-27, incl. live opencode)
- [x] failure → GitHub issue automation from dogfood (needs GH_TOKEN in /etc/sar/dogfood.env)
- [ ] fail fast on repeated provider errors instead of retrying until timeout
- [x] CI: typecheck + unit tests on every PR
- [ ] self-hosted runner on the VM: selftest per PR

## V0.3 — ближайшее, по итогам интервью 2026-09-27

- [ ] контракт результата в запросе (`expect`) → `EXPECTATION_NOT_MET`; эвристики тихого провала
- [ ] квота диска `/workspace`
- [ ] LLM-прокси на хосте: ключи провайдера (в т.ч. пользовательские, BYOK) вне комнаты, учёт токенов/стоимости
- [ ] API-ключи на пользователя, owner у рана, квоты, rate limit
- [ ] публичный HTTPS + SSRF-фильтр вебхуков; ключи для фронтенда
- [ ] адаптер `custom` (свой образ/команда)

## V0.5 — persistent storage

- [ ] durable run/artifact store on the machine's disk (sqlite index + files), disk budget
- [ ] storage gateway
- [ ] hydrate selected inputs
- [ ] export selected artifacts
- [ ] no storage credential inside the room (artifacts only via bind mounts / API)
- [ ] deleting local room/cache does not remove durable data

## V0.6 — repository preparation

- [ ] repository source descriptor
- [ ] private per-run checkout
- [ ] trusted read-only repo cache
- [ ] later: copy-on-write optimization
- [ ] no shared writable Git state between tenants

## V0.7 — secrets/capabilities

- [ ] per-user secret files on the machine (root-owned, never mounted into rooms)
- [ ] runtime-scoped provider credentials
- [ ] narrow tool/capability gateway
- [ ] secret redaction from logs

## V1 — dogfood from trained-assist

- [ ] one low-risk trained-assist workflow calls `POST /runs`
- [ ] no direct filesystem sharing between trained-assist and room
- [ ] events/status flow back through API
- [ ] explicit rollback path during pilot
- [ ] measure startup time, peak RSS, CPU, disk and teardown time
- [ ] security suite on every release

### V1 cutover criterion

Once stable, direct execution of user-controlled agent commands on the host is disabled. All user-agent execution must pass through this runtime.

## Later

Multi-host scheduling, horizontal autoscaling, live cloud-drive mounts, dedicated tenant encryption keys, browser workers, multi-region storage, billing/quotas, and resumable durable workflows are explicitly later work.
