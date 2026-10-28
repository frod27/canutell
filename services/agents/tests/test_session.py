"""A session plays through the protocol only (invariant 15), timed like a human (14), isolated from others (7)."""

import asyncio
import json
import random
from typing import Any

from aiohttp import web

from canutell_agents.chat import ScriptedChat
from canutell_agents.protocol import check_client_frame
from canutell_agents.session import DEADLINE_MARGIN_MS, AgentSession
from canutell_agents.timing import MIN_REACTION_MS, LatencyModel


def new_session(url: str, token: str = "t" * 20, speed: float = 1000.0) -> AgentSession:
    return AgentSession(url, token, "seed-" + token, LatencyModel(), ScriptedChat(random.Random(0)), clock_speed=speed)


def test_sessions_share_no_mutable_state() -> None:
    model = LatencyModel()
    a = AgentSession("ws://x", "a" * 20, "s1", model, ScriptedChat(random.Random(1)))
    b = AgentSession("ws://x", "b" * 20, "s2", model, ScriptedChat(random.Random(2)))
    for attr in ("rng", "policy", "timing", "report", "_answered", "_planned", "_tasks", "chat"):
        assert getattr(a, attr) is not getattr(b, attr), attr
    assert a.policy.rng is a.rng and b.policy.rng is b.rng
    # The only shared object is the read-only latency model.
    assert a.timing.model is b.timing.model


async def test_plays_a_phase_through_the_protocol(views: list[dict[str, Any]]) -> None:
    view = next(v for v in views if v["phase"] == "invest" and v["round"] == 1)
    received: list[dict[str, Any]] = []
    done = asyncio.Event()

    async def ws_handler(request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        async for msg in ws:
            frame = json.loads(msg.data)
            check_client_frame(frame)  # the agent only sends protocol-valid frames
            received.append(frame)
            if frame["type"] == "hello":
                await ws.send_json(
                    {
                        "type": "welcome",
                        "playerId": "b_1",
                        "token": "t" * 20,
                        "serverTime": 1000,
                        "resumedMatchId": None,
                    }
                )
                await ws.send_json(
                    {
                        "type": "match.found",
                        "matchId": view["matchId"],
                        "seat": view["seat"],
                        "mode": view["mode"],
                        "disclosure": "x",
                    }
                )
                await ws.send_json(
                    {"type": "view", "matchId": view["matchId"], "viewVersion": 1, "serverTime": 1000, "view": view}
                )
            elif frame["type"] == "action" and frame["action"]["type"] == "invest":
                reveal = {**view, "phase": "reveal", "prompts": [], "deadline": None}
                await ws.send_json(
                    {"type": "view", "matchId": view["matchId"], "viewVersion": 2, "serverTime": 2000, "view": reveal}
                )
                done.set()
        return ws

    app = web.Application()
    app.router.add_get("/", ws_handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
    session = new_session(f"ws://127.0.0.1:{port}/", speed=1000.0)
    loop = asyncio.get_running_loop()
    t0 = loop.time()
    report = await asyncio.wait_for(session.run(), timeout=10)
    elapsed_virtual_ms = (loop.time() - t0) * 1000 * 1000
    await runner.cleanup()

    assert done.is_set() and report.reached_reveal
    assert received[0] == {"type": "hello", "token": "t" * 20}
    action = next(f for f in received if f["type"] == "action" and f["action"]["type"] == "invest")
    assert action["action"]["seat"] == view["seat"]
    assert 0 < action["confidence"] <= 1
    assert action["seenPhase"] == {"round": 1, "phase": "invest"}
    assert report.used_latency_prior  # no human data yet
    assert elapsed_virtual_ms >= MIN_REACTION_MS  # never instant


def test_rushing_near_the_deadline_never_beats_the_reaction_floor(views: list[dict[str, Any]]) -> None:
    """Regression: the rush path once scaled a delay below MIN_REACTION_MS when the deadline was close."""
    prompted = [v for v in views if v["prompts"] and v["deadline"] is not None]
    for i, view in enumerate(prompted[:40]):
        for remaining in (0, 900, 2_000, 2_700, 2_900, 3_500, 6_000, 60_000):
            s = new_session("ws://x", token=f"{i:02d}-{remaining:06d}".ljust(20, "x"))
            delays: list[float] = []

            def capture(_key: str, delay_ms: float, out: list[float] = delays) -> None:
                out.append(delay_ms)

            s._act_later = capture  # type: ignore[method-assign,assignment]
            s._spawn = lambda _coro: None  # type: ignore[method-assign]
            s._maybe_chat = lambda _v, _r: None  # type: ignore[method-assign]
            s._plan(view, view["deadline"] - remaining)
            for d in delays:
                assert d >= MIN_REACTION_MS, (remaining, d)
                assert d <= remaining - DEADLINE_MARGIN_MS, (remaining, d)
