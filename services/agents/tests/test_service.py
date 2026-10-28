"""The control surface: authenticated, validated, and it never learns which match a seat is in."""

from typing import Any

from aiohttp.test_utils import TestClient, TestServer

from canutell_agents import AGENT_VERSION
from canutell_agents.service import AgentService
from canutell_agents.timing import LatencyModel


async def client_for(service: AgentService) -> TestClient:
    client = TestClient(TestServer(service.app()))
    await client.start_server()
    return client


def seat_body(**over: Any) -> dict[str, Any]:
    return {
        "serverUrl": "ws://127.0.0.1:1/",
        "token": "a" * 48,
        "agentVersion": AGENT_VERSION,
        "clockSpeed": 1,
        **over,
    }


async def test_seat_requests_are_authenticated_and_validated() -> None:
    service = AgentService("s3cret", LatencyModel())
    c = await client_for(service)
    try:
        assert (await c.post("/seats", json=seat_body(), headers={"x-agent-secret": "nope"})).status == 403
        h = {"x-agent-secret": "s3cret"}
        assert (await c.post("/seats", json=seat_body(serverUrl="ws://evil.example/"), headers=h)).status == 400
        assert (await c.post("/seats", json=seat_body(agentVersion="mimic-9"), headers=h)).status == 409
        assert (await c.post("/seats", json={"token": "x"}, headers=h)).status == 400
        r = await c.post("/seats", json=seat_body(), headers=h)
        assert r.status == 200
        body = await r.json()
        assert body == {"accepted": True, "agentVersion": AGENT_VERSION, "flags": ["latency_prior", "scripted_chat"]}
        health = await (await c.get("/health")).json()
        assert health["ok"] and health["chat"] == "scripted"
    finally:
        for task in list(service.sessions.values()):
            task.cancel()
        await c.close()


def test_sessions_are_indexed_by_token_only() -> None:
    service = AgentService("s", LatencyModel())
    assert set(vars(service)) == {"secret", "latency_model", "allowed", "llm", "chat_model", "sessions", "completed"}
