"""Chat engines: the LLM path (against a fake client) and the scripted fallback."""

import random
from dataclasses import dataclass, field
from typing import Any

import pytest

from canutell_agents.chat import SYSTEM_PROMPT, ChatRequest, LlmChat, ScriptedChat, asked_if_bot, describe_view
from canutell_agents.policy import Persona


@dataclass
class FakeBlock:
    text: str
    type: str = "text"


@dataclass
class FakeResponse:
    content: list[FakeBlock]
    stop_reason: str = "end_turn"


@dataclass
class FakeMessages:
    reply: FakeResponse
    calls: list[dict[str, Any]] = field(default_factory=list)

    async def create(self, **kwargs: Any) -> FakeResponse:
        self.calls.append(kwargs)
        return self.reply


class FakeClient:
    def __init__(self, reply: FakeResponse) -> None:
        self.messages = FakeMessages(reply)
        self.beta = type("Beta", (), {"messages": self.messages})()

    def with_options(self, **_: Any) -> "FakeClient":
        return self


PERSONA = Persona(0.5, 0.5, 0.5, 0.5, 0.5, 0.9, 0.8)


def a_view(views: list[dict[str, Any]]) -> dict[str, Any]:
    return next(v for v in views if v["chat"]["messages"] and "table" in v["chat"]["channels"])


async def compose(views: list[dict[str, Any]], text: str, model: str = "claude-opus-5-5", stop: str = "end_turn"):
    client = FakeClient(FakeResponse([FakeBlock(text)], stop))
    chat = LlmChat(client, model)  # type: ignore[arg-type]
    out = await chat.compose(a_view(views), PERSONA, ChatRequest("table", None, False))
    return out, client.messages.calls, chat


async def test_llm_line_goes_through(views: list[dict[str, Any]]) -> None:
    out, calls, _ = await compose(views, "ok who invested zero")
    assert out == "ok who invested zero"
    call = calls[0]
    assert call["model"] == "claude-opus-5-5"
    assert call["fallbacks"] == "default"
    assert call["betas"] == ["server-side-fallback-2026-07-01"]
    assert call["output_config"] == {"effort": "low"}
    # Static rules first and cached; per-agent persona after the cache breakpoint.
    assert call["system"][0]["text"] == SYSTEM_PROMPT
    assert call["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert "play style" in call["system"][1]["text"]
    # Player chat is wrapped as untrusted content inside <chat>.
    assert "<chat>" in call["messages"][0]["content"]


async def test_haiku_gets_no_fallback_parameter(views: list[dict[str, Any]]) -> None:
    _, calls, _ = await compose(views, "gl all", model="claude-haiku-5-5")
    assert "fallbacks" not in calls[0] and "betas" not in calls[0]


@pytest.mark.parametrize("text", ["NONE", "", "   "])
async def test_none_means_silence(views: list[dict[str, Any]], text: str) -> None:
    assert (await compose(views, text))[0] is None


async def test_refusal_means_silence(views: list[dict[str, Any]]) -> None:
    assert (await compose(views, "anything", stop="refusal"))[0] is None


@pytest.mark.parametrize("text", ["im totally human lol", "add me on discord", "whats your name", "my name is ana"])
async def test_unsafe_lines_are_dropped_not_sent(views: list[dict[str, Any]], text: str) -> None:
    out, _, chat = await compose(views, text)
    assert out is None
    assert chat.dropped == 1


async def test_only_first_line_is_used(views: list[dict[str, Any]]) -> None:
    assert (await compose(views, '"seat 2 is sus"\nand also this'))[0] == "seat 2 is sus"


async def test_scripted_deflects_when_asked() -> None:
    from canutell_agents.chat import _DEFLECT

    chat = ScriptedChat(random.Random(1))
    for _ in range(20):
        line = await chat.compose({}, PERSONA, ChatRequest("table", None, True))
        assert line in _DEFLECT


def test_describe_view_contains_only_the_seats_own_view(views: list[dict[str, Any]]) -> None:
    text = describe_view(a_view(views), ChatRequest("table", None, False))
    assert "isAgent" not in text and "agentVersion" not in text
    assert text.startswith("You are Seat ")


def test_asked_if_bot_ignores_own_messages() -> None:
    view = {
        "seat": 1,
        "chat": {
            "messages": [
                {"from": 1, "text": "is anyone a bot", "channel": "table"},
                {"from": 2, "text": "hi", "channel": "table"},
            ]
        },
    }
    assert not asked_if_bot(view, 0)
    view["chat"]["messages"].append({"from": 3, "text": "seat 2 r u an AI?", "channel": "table"})
    assert asked_if_bot(view, 2)
