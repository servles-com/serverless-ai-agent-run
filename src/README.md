# src

Implementation intentionally starts small.

Suggested first vertical slice:

```text
src/
  api/
  runs/
  rooms/
  adapters/
    opencode/
  storage/
```

Do not create all modules up front unless the first implementation needs them.

The important boundary is:

```text
API -> Run Manager -> Room Manager -> Agent Adapter
```

The Room Manager owns isolation and lifecycle. The Agent Adapter owns only how a specific agent runtime is invoked inside an already prepared room.
