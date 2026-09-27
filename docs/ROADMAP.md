# Roadmap

## V0 — local isolation laboratory

Goal: prove the execution-room model before integrating real product traffic.

### 1. Minimal control API

- [ ] `POST /runs`
- [ ] opaque `run_id`
- [ ] internal fake `tenant_id`
- [ ] run state machine
- [ ] `GET /runs/{id}`
- [ ] structured events

No business-domain logic.

### 2. Room lifecycle

- [ ] install/configure gVisor on the test VM
- [ ] fresh room per run
- [ ] unprivileged user
- [ ] mount only the run workspace
- [ ] memory/CPU/PID/time limits
- [ ] destroy room after terminal state
- [ ] verify background processes disappear

### 3. First agent adapter

- [ ] OpenCode adapter
- [ ] free-model development profile
- [ ] provide task text and workspace
- [ ] capture stdout/stderr/events
- [ ] export one simple artifact

### 4. Security suite

- [ ] fake tenant A
- [ ] fake tenant B with a known secret marker
- [ ] deterministic escape tests
- [ ] network-isolation tests
- [ ] resource-exhaustion tests
- [ ] adversarial LLM test trying to steal tenant B marker
- [ ] CI fails if the marker is ever exposed

## V0.5 — persistent storage

- [ ] GCS bucket in the same region as the VM
- [ ] storage gateway
- [ ] hydrate selected inputs
- [ ] export selected artifacts
- [ ] no broad GCS credential inside the room
- [ ] deleting local room/cache does not remove durable data

## V0.6 — repository preparation

- [ ] repository source descriptor
- [ ] private per-run checkout
- [ ] trusted read-only repo cache
- [ ] later: copy-on-write optimization
- [ ] no shared writable Git state between tenants

## V0.7 — secrets/capabilities

- [ ] Secret Manager integration
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
