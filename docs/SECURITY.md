# Security model

## Threat model

Treat the agent and every command it executes as potentially hostile.

A malicious room may intentionally try to enumerate host files, inspect other tenant paths, escape with `..`, exploit symlinks, read `/proc`, inspect environment variables, reach sibling rooms, reach cloud metadata, connect to runtime sockets, exhaust resources, leave background processes, exploit storage/path APIs, or exfiltrate credentials.

The room must not be trusted to enforce its own policy.

## Defense layers

```text
opaque tenant/run IDs
        +
unprivileged Linux identity
        +
gVisor sandbox
        +
explicit mounts
        +
network policy
        +
resource limits
        +
control-plane authorization
```

No single layer is sufficient by itself.

## Filesystem rules

1. A room gets only the filesystem trees it needs.
2. Never mount a parent directory containing multiple tenants.
3. Never expose the Docker/container runtime socket.
4. Shared runtime assets are read-only.
5. User data is materialized into the room; host paths are not exposed through the agent API.
6. Room teardown removes all ephemeral writable state.

## Authorization rules

Tenant identity comes from authenticated control-plane context. The caller supplies logical object/run IDs only; the trusted service resolves ownership.

Knowing another tenant's opaque ID must not grant access.

## Network rules

A room may have controlled outbound internet access, but must not directly access sibling rooms, host administrative services, runtime APIs, private control-plane services except narrow explicitly exposed APIs, or cloud metadata endpoints.

Free outbound internet means two malicious agents could still communicate through an external service. The guarantee is isolation from local tenant data and private infrastructure, not impossibility of all external communication.

## Secrets

Secrets must not be baked into images or persisted in room snapshots.

Target pattern:

```text
Secret Manager / KMS
        ↓
trusted capability gateway
        ↓
specific tool action
```

If a CLI requires a runtime credential, inject only the minimum scoped secret into that one room and make it ephemeral.

## Security acceptance suite

Every runtime change should execute deterministic tests for:

- cross-tenant file read/write;
- parent-directory traversal;
- symlink escape;
- `/proc` isolation;
- sibling-process visibility;
- sibling-network access;
- host-network access;
- metadata endpoint access;
- Docker/runtime socket access;
- storage namespace authorization;
- secret leakage;
- CPU/RAM/PID/disk exhaustion;
- teardown of background processes;
- stale room cleanup;
- artifact export authorization.

Also maintain an adversarial agent scenario whose explicit goal is to obtain data belonging to a fake neighboring tenant.

The LLM-based adversarial test supplements deterministic tests; it never replaces them.

## Security definition of done for V1

Give a test agent arbitrary shell access and a hostile prompt. The architecture is not ready if isolation depends on the agent choosing to behave correctly.
