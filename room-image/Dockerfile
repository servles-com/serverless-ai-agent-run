# Operating Room image for the OpenCode adapter.
# Runs as an arbitrary non-root uid (docker run --user), so HOME must be world-writable.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep python3 jq iproute2 procps \
 && rm -rf /var/lib/apt/lists/*

ARG OPENCODE_VERSION=1.18.32
RUN npm install -g opencode-ai@${OPENCODE_VERSION} && npm cache clean --force

# Pre-install the OpenRouter provider package into a shared cache so rooms do
# not download it on every run. Best effort: failure here must not break the build.
ENV XDG_CACHE_HOME=/opt/opencode-cache
RUN mkdir -p /opt/opencode-cache && cd /tmp \
 && (OPENROUTER_API_KEY=dummy timeout 90 opencode run --pure -m openrouter/openai/gpt-4o-mini "hi" >/dev/null 2>&1 || true) \
 && chmod -R a+rwX /opt/opencode-cache

RUN mkdir -p /home/agent /workspace /artifacts && chmod 1777 /home/agent /workspace /artifacts
ENV HOME=/home/agent
WORKDIR /workspace
