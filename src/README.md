# src

```text
API (server.ts) -> Run Manager (runner.ts, queue.ts) -> Agent Proxy (agent-proxy.ts) -> trained-assist-agent
```

The Run Manager owns the run lifecycle, events, webhooks and the verdict
(failures.ts). The Agent Proxy owns only how a run is handed to trained-assist-agent
and how its SSE answer is read back. Local Docker/gVisor rooms are paused:
docs/docker-gvisor-pause.md.
