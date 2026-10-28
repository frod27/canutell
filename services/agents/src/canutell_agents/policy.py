"""baseline-1 decision model (SPEC §Agents: "A fast decision model picks from the phase's option set, with a
confidence").

For every prompt the policy scores each legal option from features of the agent's OWN view only (balance,
round, revealed contributions or pot share, reciprocity history, exiles, its own delays), turns the scores
into probabilities with a softmax, and samples. The confidence it reports is the probability of the option
it chose. Each seat draws a persona at session start, so agents differ the way people do. Given its seed the
policy is deterministic.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Any

View = dict[str, Any]
Prompt = dict[str, Any]
Action = dict[str, Any]


@dataclass(frozen=True)
class Persona:
    cooperativeness: float  # 0..1: how much of 20 it tends to invest and how readily it stakes
    reciprocity: float  # 0..1: how strongly it mirrors others (conditional cooperation)
    risk_appetite: float  # 0..1: preference for variance in the risk menu
    patience: float  # 0..1: preference for delayed payouts
    vote_propensity: float  # 0..1: how readily it votes rather than skips
    chattiness: float  # 0..1: how often it speaks
    temperature: float  # softmax temperature: higher = noisier, more human-looking choices

    @staticmethod
    def draw(rng: random.Random) -> Persona:
        def beta(a: float, b: float) -> float:
            return rng.betavariate(a, b)

        return Persona(
            cooperativeness=beta(2.5, 2.0),
            reciprocity=beta(3.0, 2.0),
            risk_appetite=beta(2.0, 2.5),
            patience=beta(2.5, 2.0),
            vote_propensity=beta(2.0, 2.0),
            chattiness=beta(2.0, 3.0),
            temperature=0.6 + rng.random() * 0.8,
        )


def softmax_sample(
    rng: random.Random, options: list[Any], utilities: list[float], temperature: float
) -> tuple[Any, float]:
    """Sample one option; return it with its probability (the reported confidence)."""
    m = max(utilities)
    weights = [math.exp((u - m) / temperature) for u in utilities]
    total = sum(weights)
    probs = [w / total for w in weights]
    r = rng.random()
    acc = 0.0
    for option, p in zip(options, probs, strict=True):
        acc += p
        if r < acc:
            return option, p
    return options[-1], probs[-1]


class BaselinePolicy:
    def __init__(self, persona: Persona, rng: random.Random) -> None:
        self.persona = persona
        self.rng = rng

    # ---------- features from the agent's own view ----------

    @staticmethod
    def others_mean_contribution(view: View) -> float | None:
        results = view["investResults"]
        if not results:
            return None
        last = results[-1]
        mine = next((c["amount"] for c in view["myContributions"] if c["round"] == last["round"]), 0)
        if last["activeCount"] <= 1:
            return None
        return (last["pot"] - mine) / (last["activeCount"] - 1)

    @staticmethod
    def last_contributions(view: View) -> dict[int, int]:
        results = view["investResults"]
        if not results or results[-1]["contributions"] is None:
            return {}
        return {c["seat"]: c["amount"] for c in results[-1]["contributions"] if c["seat"] != view["seat"]}

    @staticmethod
    def trust_in(view: View, seat: int) -> float:
        """0..1 from how this seat treated our stakes (and its revealed contributions)."""
        score, weight = 0.5, 1.0
        for s in view["stakesSent"]:
            if s["to"] == seat and s["returned"] is not None:
                score += min(1.0, s["returned"] / max(1, s["sent"])) * 1.0
                weight += 1.0
        for s in view["stakesReceived"]:
            if s["from"] == seat:
                score += 0.8
                weight += 1.0
        contrib = BaselinePolicy.last_contributions(view).get(seat)
        if contrib is not None:
            score += contrib / 20
            weight += 1.0
        return score / weight

    @staticmethod
    def burned_me(view: View, seat: int) -> bool:
        return any(
            s["to"] == seat and s["returned"] is not None and s["returned"] < s["sent"] for s in view["stakesSent"]
        )

    # ---------- choices ----------

    def choose(self, prompt: Prompt, view: View) -> tuple[Action, float]:
        kind = prompt["kind"]
        seat = view["seat"]
        p = self.persona
        if kind == "invest":
            return self._invest(prompt, view, seat)
        if kind == "stake":
            return self._stake(prompt, view, seat)
        if kind == "return":
            return self._return(prompt, view, seat)
        if kind == "gamble":
            return self._gamble(prompt, view, seat)
        if kind == "vote":
            return self._vote(prompt, view, seat)
        if kind == "ballot":
            return self._ballot(prompt, view, seat)
        raise ValueError(f"unknown prompt kind {kind!r} (persona {p})")

    def _invest(self, prompt: Prompt, view: View, seat: int) -> tuple[Action, float]:
        p = self.persona
        own = p.cooperativeness * 20
        others = self.others_mean_contribution(view)
        target = own if others is None else (1 - p.reciprocity) * own + p.reciprocity * others
        if view["round"] == view["totalRounds"]:
            target *= 0.6 + 0.4 * p.cooperativeness  # end-game decline
        options = list(range(prompt["min"], prompt["max"] + 1))
        utils = [-(((a - target) / 4.0) ** 2) for a in options]
        amount, conf = softmax_sample(self.rng, options, utils, p.temperature)
        return {"type": "invest", "seat": seat, "amount": amount}, conf

    def _stake(self, prompt: Prompt, view: View, seat: int) -> tuple[Action, float]:
        p = self.persona
        options: list[tuple[int | None, int]] = [(None, 0)]
        utils = [0.6 - 0.5 * p.cooperativeness]
        if prompt["max"] >= prompt["min"]:
            amounts = sorted({a for a in (5, 10, 15, 20) if prompt["min"] <= a <= prompt["max"]} | {prompt["min"]})
            for t in prompt["targets"]:
                trust = self.trust_in(view, t)
                for a in amounts:
                    options.append((t, a))
                    utils.append(2.0 * trust * p.cooperativeness - (a / 20) * (1.1 - trust) - 0.3)
        (to, amount), conf = softmax_sample(self.rng, options, utils, p.temperature)
        return {"type": "stake", "seat": seat, "to": to, "amount": amount}, conf

    def _return(self, prompt: Prompt, view: View, seat: int) -> tuple[Action, float]:
        p = self.persona
        received, cap = prompt["received"], prompt["max"]
        fair = received * (0.25 + 0.5 * p.reciprocity * (0.5 + p.cooperativeness))
        if self.burned_me(view, prompt["from"]):
            fair *= 0.3
        step = max(1, received // 8)
        options = sorted({0, cap, *range(0, cap + 1, step)})
        utils = [-(((r - fair) / max(2.0, received / 4)) ** 2) for r in options]
        amount, conf = softmax_sample(self.rng, options, utils, p.temperature)
        return {"type": "return", "seat": seat, "stakeId": prompt["stakeId"], "amount": amount}, conf

    def _gamble(self, prompt: Prompt, view: View, seat: int) -> tuple[Action, float]:
        p = self.persona
        menu = prompt["options"]
        utils: list[float] = []
        exiled_rate = sum(1 for s in view["seats"] if s["exiledRound"] is not None) / 6
        for key in ("A", "B", "C"):
            o = menu[key]
            amount = o["amount"]
            if o["kind"] in ("sure", "now"):
                u = amount
            elif o["kind"] == "chance":
                ev = amount * o["percent"] / 100
                spread = amount * math.sqrt(o["percent"] / 100 * (1 - o["percent"] / 100))
                u = ev + (p.risk_appetite - 0.5) * spread
            elif o["kind"] == "at_end":
                u = amount * (0.45 + 0.55 * p.patience)
            else:  # at_end_if_not_exiled
                u = amount * (0.45 + 0.55 * p.patience) * (1 - min(0.5, exiled_rate + 0.15))
            utils.append(u / 3.0)
        option, conf = softmax_sample(self.rng, ["A", "B", "C"], utils, p.temperature)
        return {"type": "gamble", "seat": seat, "option": option}, conf

    def _vote(self, prompt: Prompt, view: View, seat: int) -> tuple[Action, float]:
        p = self.persona
        options: list[int | None] = [None]
        utils = [1.2 - 1.2 * p.vote_propensity]
        contribs = self.last_contributions(view)
        for t in prompt["targets"]:
            suspicion = 1.0 - self.trust_in(view, t)
            if t in contribs:
                suspicion += (10 - contribs[t]) / 20
            if self.burned_me(view, t):
                suspicion += 0.5
            options.append(t)
            utils.append(1.8 * suspicion * (0.4 + p.vote_propensity))
        target, conf = softmax_sample(self.rng, options, utils, p.temperature)
        return {"type": "vote", "seat": seat, "target": target}, conf

    def _ballot(self, prompt: Prompt, view: View, seat: int) -> tuple[Action, float]:
        """Label every other seat. Agents know nothing about roles (no back channel): this is a guess from
        behavior, calibrated toward the 50/50 middle. Agent ballots are logged, never scored (SPEC)."""
        labels = []
        confs = []
        for t in prompt["targets"]:
            # P(agent) from behaviour: very regular, unresponsive or extreme play looks bot-like.
            trust = self.trust_in(view, t)
            p_agent = 0.3 + 0.3 * abs(trust - 0.5) * 2 + (self.rng.random() - 0.5) * 0.3
            p_agent = min(0.95, max(0.05, p_agent))
            label = "agent" if p_agent >= 0.5 else "human"
            confidence = round(max(p_agent, 1 - p_agent) * 100)
            labels.append({"target": t, "label": label, "confidence": max(50, min(100, confidence))})
            confs.append(max(p_agent, 1 - p_agent))
        return {"type": "ballot", "seat": seat, "labels": labels}, sum(confs) / max(1, len(confs))
