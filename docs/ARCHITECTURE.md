# Architecture

## Boundary

This repository owns only the **execution runtime**. Product/business orchestration stays outside it.

```text
trained-assist / external client
           |
           v
     Execution API
           |
           v
      Run Manager
           |
           v
      Room Manager
           |
           v
   isolated agent room
```

A client should be able to move this runtime to another machine by changing only the service URL and credentials.

## Planes

### Control Plane

Trusted components: API, authentication/authorization, run registry, room lifecycle manager, storage gateway, secret/capability gateway, and audit/event stream.

The control plane resolves tenant ownership internally. A request must never choose an arbitrary host path or tenant namespace.

### Execution Plane

One isolated room per run in V0:

```text
/
├── workspace/
├── context/
├── input/
├── artifacts/
├── tmp/
└── agent-runtime/
```

The room gets an unprivileged identity, isolated filesystem/process view, network restrictions, CPU/memory/PID/time limits, and no Docker socket or host administration interfaces.

Target runtime: Docker/containerd + gVisor `runsc`, pending compatibility testing with OpenCode.

### Persistent Plane

V0 uses a local fake object-store layout for tests.

Hosting constraint (2026-09-27): **one bare Linux machine, no cloud services.** Persistence stays on the machine's disk (run dirs, sqlite index); secrets stay in root-owned files; off-machine backup is a plain rsync to a second box when one exists.

The VM disk is disposable cache and temporary execution storage.

## Run lifecycle

```text
POST /runs
   ↓
authenticate caller
   ↓
resolve tenant internally
   ↓
create run record
   ↓
hydrate selected inputs
   ↓
spawn fresh room
   ↓
execute agent
   ↓
collect result + artifacts
   ↓
persist selected outputs
   ↓
sterilize / destroy room
```

A room is never the durable source of truth.

## API shape

```http
POST /runs
GET  /runs/{run_id}
POST /runs/{run_id}/messages
POST /runs/{run_id}/cancel
GET  /runs/{run_id}/events
GET  /runs/{run_id}/artifacts
```

V0 may implement only `POST /runs`, `GET /runs/{run_id}` and `GET /runs/{run_id}/events`. Creating a run returns a `run_id`; the HTTP request does not stay open for the lifetime of the agent.

## Storage model

Persistent storage and the agent filesystem are separate abstractions.

```text
persistent storage
      ↓ hydrate selected data
ephemeral POSIX filesystem
      ↓ agent works
selected artifacts/state
      ↓
persistent storage
```

The room should not receive broad storage credentials. A trusted storage gateway maps:

```text
room_id -> run_id -> tenant_id -> allowed storage namespace
```

## Repository handling

Never bind multiple tenants to one writable checkout.

```text
trusted repository cache (read-only)
              ↓
private per-run writable copy / CoW layer
              ↓
Operating Room
```

The first implementation may use a normal private clone. Optimization comes later.

## Model-provider abstraction

The runtime must not hardcode one provider. Initial development can use an OpenRouter free profile; later users can supply their own provider/API credentials.

## Resource model

V0 has one concurrent room with explicit memory, CPU, PID, disk and execution-time limits. Do not rely on host defaults.

## Failure semantics

A run ends in an explicit state:

```text
QUEUED
PREPARING
RUNNING
EXPORTING
SUCCEEDED
FAILED
CANCELLED
TIMED_OUT
AUTH_REQUIRED
```

Room teardown runs for every terminal state. If artifact export fails, the run must not be reported as fully successful.

## Critical invariant

If the whole execution VM disappears, durable user data must survive. A disposable room may lose work since the last persisted checkpoint, but must not destroy durable user data or artifacts.
