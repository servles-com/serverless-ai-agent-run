# src

```text
API (server.ts) -> Run Manager (runner.ts, queue.ts) -> Agent Proxy (agent-proxy.ts) -> configured backend
```

The Run Manager owns the run lifecycle, events, webhooks and the verdict
(failures.ts). The Agent Proxy owns backend-specific submit, event streaming, cancel and health
for trained-assist-agent or the opt-in Runner API. Local Docker/gVisor rooms are paused:
docs/docker-gvisor-pause.md.
