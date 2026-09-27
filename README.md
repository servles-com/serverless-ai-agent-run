# serverless-ai-agent-run

Experimental runtime for **isolated, ephemeral AI-agent execution on a shared VM**.

The core idea:

- persistent user data lives outside the execution environment;
- every run gets a fresh isolated **Operating Room**;
- only data required for that run is materialized inside it;
- the agent works with a normal filesystem and shell;
- selected artifacts/state are exported to persistent storage;
- the room is destroyed after execution.

This repository owns the execution layer, not product/business orchestration.

## North star

```text
Client / trained-assist
        |
        | POST /runs
        v
+------------------------+
| Control Plane          |
| API + Run Manager      |
+-----------+------------+
            |
            | allocate
            v
+------------------------+
| Operating Room         |
| isolated ephemeral env |
|                        |
| OpenCode / Hermes      |
| shell                  |
| /workspace             |
| /context               |
| /input                 |
| /artifacts             |
+-----------+------------+
            |
            | export
            v
+------------------------+
| Persistent Plane       |
| GCS / DB / KMS         |
+------------------------+

destroy / sterilize room
```

## Security invariant

The runtime must remain safe even if the agent inside a room is fully hostile.

A room must not be able to read another tenant's filesystem, inspect another room's processes, access runtime control sockets, reach host-management/cloud-metadata endpoints, request another tenant's objects, keep processes alive after teardown, or escape resource limits.

Tenant identity is derived from authenticated control-plane context, never from a path or tenant ID supplied by the agent.

## V0 scope

1. One existing test VM.
2. One concurrent room.
3. OpenCode as the first runtime adapter.
4. Free-model profile for development.
5. Local fake persistent storage first.
6. Docker/containerd + gVisor `runsc` as the target isolation runtime, subject to compatibility tests.
7. Explicit lifecycle: `hydrate -> execute -> export -> sterilize`.
8. Security regression suite from day one.

GCS is introduced only after the isolation/lifecycle model works locally.

## Repository map

```text
docs/
  ARCHITECTURE.md
  SECURITY.md
  ROADMAP.md
src/
  README.md
tests/
  security/
    README.md
```

## Terminology

**Agent** — logical configuration and capabilities.  
**Run** — one execution request.  
**Operating Room / Room** — isolated ephemeral execution environment created for one run.  
**Control Plane** — trusted API and lifecycle manager.  
**Persistent Plane** — durable user data, artifacts, run metadata and secrets.

## Non-goals for V0

No Kubernetes, multi-region scheduling, multi-host autoscaling, shared writable tenant workspaces, browser automation, production billing, or complex workflow orchestration.

## Lab host

The initial lab can intentionally be small: 1 vCPU, 1 GB RAM, 30 GB NVMe and optional 2–4 GB swap. V0 runs one room at a time; this is a test target, not production sizing.
