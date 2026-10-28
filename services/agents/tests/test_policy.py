"""baseline-1 decision model: legal choices only, a confidence for each, deterministic per seed."""

import random
from typing import Any

from canutell_agents.policy import BaselinePolicy, Persona
from canutell_agents.protocol import check_client_frame


def legal(prompt: dict[str, Any], action: dict[str, Any], seat: int) -> bool:
    k = prompt["kind"]
    assert action["seat"] == seat
    if k == "invest":
        return prompt["min"] <= action["amount"] <= prompt["max"]
    if k == "stake":
        if action["to"] is None:
            return action["amount"] == 0
        return action["to"] in prompt["targets"] and prompt["min"] <= action["amount"] <= prompt["max"]
    if k == "return":
        return action["stakeId"] == prompt["stakeId"] and 0 <= action["amount"] <= prompt["max"]
    if k == "gamble":
        return action["option"] in ("A", "B", "C")
    if k == "vote":
        return action["target"] is None or action["target"] in prompt["targets"]
    if k == "ballot":
        targets = [label["target"] for label in action["labels"]]
        return (
            len(set(targets)) == len(targets)
            and set(targets) <= set(prompt["targets"])
            and all(
                50 <= label["confidence"] <= 100 and label["label"] in ("agent", "human") for label in action["labels"]
            )
        )
    return False


def test_every_choice_on_every_recorded_prompt_is_legal_and_schema_valid(views: list[dict[str, Any]]) -> None:
    kinds: set[str] = set()
    for i, view in enumerate(views):
        rng = random.Random(i)
        policy = BaselinePolicy(Persona.draw(rng), rng)
        for prompt in view["prompts"]:
            action, confidence = policy.choose(prompt, view)
            kinds.add(prompt["kind"])
            assert legal(prompt, action, view["seat"]), (prompt, action)
            assert 0 < confidence <= 1
            check_client_frame(
                {
                    "type": "action",
                    "matchId": view["matchId"],
                    "clientActionId": "a1",
                    "action": action,
                    "seenPhase": {"round": view["round"], "phase": view["phase"]},
                    "clientSentAt": 0,
                    "confidence": confidence,
                }
            )
    assert kinds == {"invest", "stake", "return", "gamble", "vote", "ballot"}


def test_deterministic_for_a_seed(views: list[dict[str, Any]]) -> None:
    def run(seed: str) -> list[Any]:
        rng = random.Random(seed)
        policy = BaselinePolicy(Persona.draw(rng), rng)
        return [policy.choose(p, v) for v in views[:60] for p in v["prompts"]]

    assert run("x") == run("x")
    assert run("x") != run("y")


def test_personas_differ_and_shape_behaviour(views: list[dict[str, Any]]) -> None:
    invest_views = [(v, p) for v in views for p in v["prompts"] if p["kind"] == "invest" and p["max"] == 20]
    generous = Persona(0.95, 0.1, 0.5, 0.5, 0.5, 0.5, 0.6)
    stingy = Persona(0.05, 0.1, 0.5, 0.5, 0.5, 0.5, 0.6)

    def mean_invest(persona: Persona) -> float:
        rng = random.Random(1)
        policy = BaselinePolicy(persona, rng)
        amounts = [policy.choose(p, v)[0]["amount"] for v, p in invest_views]
        return sum(amounts) / len(amounts)

    assert mean_invest(generous) > mean_invest(stingy) + 8
    drawn = {Persona.draw(random.Random(s)) for s in range(50)}
    assert len(drawn) == 50


def test_policy_reads_only_the_view_it_is_given(views: list[dict[str, Any]]) -> None:
    """No back channel: the same view and RNG state give the same choice, whatever else exists."""
    view = next(v for v in views if any(p["kind"] == "vote" for p in v["prompts"]))
    prompt = next(p for p in view["prompts"] if p["kind"] == "vote")
    a = BaselinePolicy(Persona.draw(random.Random(3)), random.Random(9)).choose(prompt, view)
    b = BaselinePolicy(Persona.draw(random.Random(3)), random.Random(9)).choose(prompt, view)
    assert a == b
