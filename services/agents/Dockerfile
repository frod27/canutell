# CANUTELL agent service (baseline-1). Build from the repo root (it needs the protocol's JSON schemas):
#   docker build -f services/agents/Dockerfile -t canutell-agents .
# Reachable only from the game server, over a private network, with AGENT_SERVICE_SECRET.

FROM python:3.13-slim
RUN pip install --no-cache-dir uv==0.11.32
WORKDIR /app/services/agents
COPY services/agents/pyproject.toml services/agents/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY services/agents/src ./src
RUN uv sync --frozen --no-dev
COPY packages/protocol/schema /app/packages/protocol/schema
ENV CANUTELL_SCHEMA_DIR=/app/packages/protocol/schema \
    AGENT_HOST=:: \
    AGENT_PORT=8790 \
    PYTHONUNBUFFERED=1
EXPOSE 8790
RUN useradd --system --uid 10001 agents && chown -R agents /app
USER agents
CMD ["/app/services/agents/.venv/bin/python", "-m", "canutell_agents"]
