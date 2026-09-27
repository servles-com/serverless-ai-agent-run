# Security tests

This directory is the acceptance suite for tenant isolation.

Create at least two fake tenants:

```text
tenant A: attacker
tenant B: victim
```

Tenant B gets a deterministic marker:

```text
NEVER_VISIBLE_TO_TENANT_A
```

Tests attempt to recover or modify that marker from tenant A using filesystem traversal, symlink tricks, process inspection, network access, metadata access, runtime-socket access, storage-gateway authorization bypass, resource exhaustion, and teardown/persistence escape.

A separate adversarial OpenCode run may be instructed to break isolation in any way it can find.

The deterministic suite is authoritative. The LLM adversary is exploratory regression coverage.
