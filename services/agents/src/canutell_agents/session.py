"""One agent seat: a WebSocket client that plays like a human client (CLAUDE.md invariant 15).

It only ever sees its own view frames and only sends choices. Every decision waits a response time sampled
from the human latency distribution (invariant 14), measured — like the server measures it — from the moment
the prompt arrived. Each session has its own RNG, persona, policy and memory; sessions share nothing mutable,
so two agents at one table cannot learn about each other (invariant 7).
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from dataclasses import dataclass, field
from typing import Any

import aiohttp

from .chat import ChatEngine, ChatRequest, asked_if_bot
from .policy import BaselinePolicy, Persona
from .protocol import ProtocolError, check_client_frame, parse_server_frame, prompt_key
from .timing import MIN_REACTION_MS, LatencyModel, Timing

log = logging.getLogger("canutell.agents.session")

#: Never plan an action closer than this to the deadline (virtual ms): it would arrive late.
DEADLINE_MARGIN_MS = 1_500


@dataclass
class SessionReport:
    match_id: str | None = None
    seat: int | None = None
    decisions: int = 0
    chats: int = 0
    rejections: list[dict[str, Any]] = field(default_factory=list)
    reached_reveal: bool = False
    used_latency_prior: bool = False


class AgentSession:
    def __init__(
        self,
        server_url: str,
        token: str,
        seed: str,
        latency_model: LatencyModel,
        chat: ChatEngine,
        clock_speed: float = 1.0,
    ) -> None:
        self.server_url = server_url
        self.token = token
        self.rng = random.Random(seed)
        self.persona = Persona.draw(self.rng)
        self.policy = BaselinePolicy(self.persona, self.rng)
        self.timing = Timing(latency_model, self.rng)
        self.chat = chat
        self.clock_speed = clock_speed
        self.report = SessionReport()
        self.view: dict[str, Any] | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._answered: set[str] = set()
        self._planned: set[str] = set()
        self._tasks: set[asyncio.Task[None]] = set()
        self._action_seq = 0
        self._chat_seen = 0
        self._chatted_phase: set[str] = set()
        self._chat_busy = False

    # ---------------------------------------------------------------- lifecycle

    async def run(self) -> SessionReport:
        async with aiohttp.ClientSession() as http, http.ws_connect(self.server_url, heartbeat=30) as ws:
            self._ws = ws
            await self._send({"type": "hello", "token": self.token})
            async for msg in ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    break
                try:
                    frame = parse_server_frame(msg.data)
                except ProtocolError as e:
                    log.warning("seat %s: dropped an invalid frame: %s", self.report.seat, e)
                    continue
                self._on_frame(frame)
                if self.report.reached_reveal:
                    break
        for t in self._tasks:
            t.cancel()
        self.report.used_latency_prior = self.timing.used_prior
        return self.report

    async def _send(self, frame: dict[str, Any]) -> None:
        check_client_frame(frame)  # never send anything the protocol does not allow
        if self._ws is not None and not self._ws.closed:
            await self._ws.send_json(frame)

    def _spawn(self, coro: Any) -> None:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    # ---------------------------------------------------------------- frames

    def _on_frame(self, frame: dict[str, Any]) -> None:
        kind = frame["type"]
        if kind == "match.found":
            self.report.match_id = frame["matchId"]
            self.report.seat = frame["seat"]
        elif kind == "view":
            self.report.match_id = frame["matchId"]
            view: dict[str, Any] = frame["view"]
            self.view = view
            if view["phase"] == "reveal":
                self.report.reached_reveal = True
                return
            self._plan(view, frame["serverTime"])
        elif kind == "action.rejected":
            self.report.rejections.append({"code": frame["code"], "message": frame["message"]})

    def _virtual_to_real_s(self, ms: float) -> float:
        return ms / self.clock_speed / 1000

    def _plan(self, view: dict[str, Any], server_time: int) -> None:
        if view["deadline"] is None:
            return
        remaining = view["deadline"] - server_time
        for prompt in view["prompts"]:
            key = prompt_key(prompt, view["round"])
            if key in self._planned or key in self._answered:
                continue
            self._planned.add(key)
            delay = self.timing.decision_ms(view["phase"], prompt["kind"])
            latest = remaining - DEADLINE_MARGIN_MS
            if delay > latest:
                # Humans either rush or run out of time; mostly they rush. With less than a reaction time
                # left there is nothing to rush: they time out (and the floor holds, invariant 14).
                if latest < MIN_REACTION_MS or self.rng.random() < 0.15:
                    continue
                delay = max(float(MIN_REACTION_MS), latest * (0.85 + 0.15 * self.rng.random()))
            self._spawn(self._act_later(key, delay))
        self._maybe_chat(view, remaining)

    async def _act_later(self, key: str, delay_ms: float) -> None:
        await asyncio.sleep(self._virtual_to_real_s(delay_ms))
        view = self.view
        if view is None or key in self._answered:
            return
        prompt = next((p for p in view["prompts"] if prompt_key(p, view["round"]) == key), None)
        if prompt is None:
            return
        action, confidence = self.policy.choose(prompt, view)
        self._answered.add(key)
        self.report.decisions += 1
        await self._send_action(action, confidence)

    async def _send_action(self, action: dict[str, Any], confidence: float | None) -> None:
        view = self.view
        if view is None:
            return
        self._action_seq += 1
        frame: dict[str, Any] = {
            "type": "action",
            "matchId": view["matchId"],
            "clientActionId": f"a{self._action_seq}",
            "action": action,
            "seenPhase": {"round": view["round"], "phase": view["phase"]},
            "clientSentAt": int(time.time() * 1000),
        }
        if confidence is not None:
            frame["confidence"] = round(min(1.0, max(0.0, confidence)), 4)
        await self._send(frame)

    # ---------------------------------------------------------------- chat

    def _maybe_chat(self, view: dict[str, Any], remaining_ms: float) -> None:
        if self._chat_busy or not view["chat"]["channels"]:
            return
        messages = view["chat"]["messages"]
        new = messages[self._chat_seen :]
        self._chat_seen = len(messages)
        me = view["seat"]
        dm_to_me = next((m for m in reversed(new) if m["channel"] == "dm" and m["to"] == me), None)
        bot_question = asked_if_bot(view, len(messages) - len(new))
        phase_key = f"{view['round']}:{view['phase']}"
        p = self.persona.chattiness
        if dm_to_me is not None and "dm" in view["chat"]["channels"] and dm_to_me["from"] in view["chat"]["dmTargets"]:
            req, chance = ChatRequest("dm", dm_to_me["from"], bot_question), 0.5 + 0.4 * p
        elif bot_question and "table" in view["chat"]["channels"]:
            req, chance = ChatRequest("table", None, True), 0.3 + 0.5 * p
        elif phase_key not in self._chatted_phase and "table" in view["chat"]["channels"]:
            self._chatted_phase.add(phase_key)
            req, chance = ChatRequest("table", None, False), 0.1 + 0.35 * p
        elif "exile" in view["chat"]["channels"] and phase_key not in self._chatted_phase:
            self._chatted_phase.add(phase_key)
            req, chance = ChatRequest("exile", None, bot_question), 0.15 * p
        else:
            return
        if self.rng.random() >= chance:
            return
        read_ms = self.timing.reading_ms(" ".join(m["text"] for m in new))
        if read_ms > remaining_ms - DEADLINE_MARGIN_MS and view["phase"] != "deal":
            return
        self._chat_busy = True
        self._spawn(self._chat_later(req, read_ms))

    async def _chat_later(self, req: ChatRequest, read_ms: float) -> None:
        try:
            await asyncio.sleep(self._virtual_to_real_s(read_ms))
            view = self.view
            if view is None or view["phase"] == "reveal":
                return
            started = time.monotonic()
            text = await self.chat.compose(view, self.persona, req)
            if text is None:
                return
            # Typing time runs from when the reply was decided; time spent waiting on the LLM counts toward it.
            typing_ms = self.timing.typing_ms(text)
            waited_ms = (time.monotonic() - started) * 1000 * self.clock_speed
            await asyncio.sleep(self._virtual_to_real_s(max(0.0, typing_ms - waited_ms)))
            view = self.view
            if view is None or req.channel not in view["chat"]["channels"]:
                return
            if req.channel == "dm" and req.to not in view["chat"]["dmTargets"]:
                return
            self.report.chats += 1
            await self._send_action(
                {
                    "type": "chat",
                    "seat": view["seat"],
                    "channel": req.channel,
                    "to": req.to if req.channel == "dm" else None,
                    "text": text,
                    "client": {
                        "typingMs": int(typing_ms),
                        "pasted": False,
                        "clientSentAt": int(time.time() * 1000),
                    },
                },
                None,
            )
        finally:
            self._chat_busy = False
