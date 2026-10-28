"""HTTP control surface: the game server asks for an agent per agent seat.

POST /seats  {serverUrl, token, agentVersion, clockSpeed}  (header x-agent-secret)
    → 200 {accepted, agentVersion, flags}; the service then connects to serverUrl over WebSocket with the
      token, exactly like a reconnecting player. Nothing about the match is sent (no back channel), and
      sessions are kept by token only — never grouped by match.
GET  /health → {ok, sessions, agentVersion, chat}

Configuration (environment):
    AGENT_SERVICE_SECRET   shared secret the game server sends (required)
    AGENT_SERVER_URLS      comma-separated allowed game-server WebSocket URLs (default: localhost only)
    AGENT_LATENCY_MODEL    path to the exported human latency model (default: data/latency.json)
    AGENT_CHAT_MODEL       Claude model for chat (default claude-opus-5-5); needs ANTHROPIC_API_KEY or another
                           credential the Anthropic SDK resolves — without one, scripted chat is used
    AGENT_HOST / AGENT_PORT  listen address (default 127.0.0.1:8790; port 0 picks a free port)
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import os
import random
import secrets
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import anthropic
from aiohttp import web

from . import AGENT_VERSION
from .chat import DEFAULT_MODEL, ChatEngine, LlmChat, ScriptedChat
from .session import AgentSession
from .timing import LatencyModel

log = logging.getLogger("canutell.agents.service")
DEFAULT_LATENCY_PATH = Path(__file__).resolve().parents[2] / "data" / "latency.json"


def _has_llm_credentials() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


class AgentService:
    def __init__(
        self,
        secret: str,
        latency_model: LatencyModel,
        allowed_server_urls: list[str] | None = None,
        llm: anthropic.AsyncAnthropic | None = None,
        chat_model: str = DEFAULT_MODEL,
    ) -> None:
        self.secret = secret
        self.latency_model = latency_model
        self.allowed = allowed_server_urls
        self.llm = llm
        self.chat_model = chat_model
        self.sessions: dict[str, asyncio.Task[Any]] = {}  # by token only
        self.completed = 0

    def _server_url_allowed(self, url: str) -> bool:
        if self.allowed is not None:
            return url in self.allowed
        parsed = urlparse(url)
        return parsed.scheme in ("ws", "wss") and parsed.hostname in ("127.0.0.1", "localhost", "::1")

    def flags(self) -> list[str]:
        flags = []
        if not self.latency_model.fully_human:
            flags.append("latency_prior")
        if self.llm is None:
            flags.append("scripted_chat")
        return flags

    def _chat_engine(self, rng: random.Random) -> ChatEngine:
        return LlmChat(self.llm, self.chat_model) if self.llm is not None else ScriptedChat(rng)

    async def handle_seat(self, request: web.Request) -> web.Response:
        if not hmac.compare_digest(request.headers.get("x-agent-secret", ""), self.secret):
            return web.json_response({"error": "forbidden"}, status=403)
        try:
            body = await request.json()
            server_url, token = str(body["serverUrl"]), str(body["token"])
            speed = float(body.get("clockSpeed", 1))
        except (ValueError, KeyError, TypeError):
            return web.json_response({"error": "bad request"}, status=400)
        if body.get("agentVersion") != AGENT_VERSION:
            return web.json_response({"error": f"this service runs {AGENT_VERSION}"}, status=409)
        if not self._server_url_allowed(server_url) or not (0 < speed <= 1000) or len(token) > 128:
            return web.json_response({"error": "bad request"}, status=400)
        seed = secrets.token_hex(16)  # each seat: fresh, independent randomness
        session = AgentSession(
            server_url,
            token,
            seed,
            self.latency_model,
            self._chat_engine(random.Random(seed + ":chat")),
            clock_speed=speed,
        )
        task = asyncio.create_task(session.run())
        self.sessions[token] = task

        def done(t: asyncio.Task[Any]) -> None:
            self.sessions.pop(token, None)
            self.completed += 1
            if not t.cancelled() and t.exception() is not None:
                log.warning("agent session ended with an error: %s", t.exception())

        task.add_done_callback(done)
        return web.json_response({"accepted": True, "agentVersion": AGENT_VERSION, "flags": self.flags()})

    async def handle_health(self, _request: web.Request) -> web.Response:
        return web.json_response(
            {
                "ok": True,
                "agentVersion": AGENT_VERSION,
                "sessions": len(self.sessions),
                "completed": self.completed,
                "chat": "llm" if self.llm is not None else "scripted",
                "flags": self.flags(),
            }
        )

    def app(self) -> web.Application:
        app = web.Application(client_max_size=16 * 1024)
        app.router.add_post("/seats", self.handle_seat)
        app.router.add_get("/health", self.handle_health)
        return app


def build_from_env() -> AgentService:
    secret = os.environ.get("AGENT_SERVICE_SECRET")
    if not secret:
        raise SystemExit("AGENT_SERVICE_SECRET is required")
    urls = os.environ.get("AGENT_SERVER_URLS")
    latency_path = os.environ.get("AGENT_LATENCY_MODEL", str(DEFAULT_LATENCY_PATH))
    llm = anthropic.AsyncAnthropic() if _has_llm_credentials() else None
    return AgentService(
        secret=secret,
        latency_model=LatencyModel.load(latency_path),
        allowed_server_urls=[u.strip() for u in urls.split(",")] if urls else None,
        llm=llm,
        chat_model=os.environ.get("AGENT_CHAT_MODEL", DEFAULT_MODEL),
    )


async def serve(service: AgentService, host: str, port: int) -> None:
    runner = web.AppRunner(service.app())
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    await site.start()
    sockets = site._server.sockets if site._server else []  # type: ignore[union-attr]
    bound = sockets[0].getsockname()[1] if sockets else port
    # The load test reads this line to find the port.
    print(f"AGENT_SERVICE_LISTENING {bound}", flush=True)
    log.info(
        "agent service %s on %s:%s — chat: %s, flags: %s",
        AGENT_VERSION,
        host,
        bound,
        "llm" if service.llm else "scripted",
        service.flags(),
    )
    await asyncio.Event().wait()
