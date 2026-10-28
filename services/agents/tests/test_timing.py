"""CLAUDE.md invariant 14: timing sampled from the human distribution per phase, never instant."""

import json
import math
import random
from pathlib import Path

from canutell_agents.timing import MIN_REACTION_MS, PRIOR, LatencyModel, Timing


def ks_distance(sample: list[float], reference: list[float]) -> float:
    """Two-sample Kolmogorov-Smirnov statistic."""
    a, b = sorted(sample), sorted(reference)
    i = j = 0
    d = 0.0
    while i < len(a) and j < len(b):
        if a[i] <= b[j]:
            i += 1
        else:
            j += 1
        d = max(d, abs(i / len(a) - j / len(b)))
    return d


def test_no_data_uses_the_prior_and_says_so() -> None:
    t = Timing(LatencyModel.load(None), random.Random(1))
    xs = [t.decision_ms("invest", "invest") for _ in range(2000)]
    assert t.used_prior
    assert min(xs) >= MIN_REACTION_MS
    median = sorted(xs)[1000]
    assert abs(math.log(median / PRIOR["invest"][0])) < 0.1


def test_never_instant_for_any_kind() -> None:
    t = Timing(LatencyModel(), random.Random(2))
    for kind in PRIOR:
        assert min(t.decision_ms("deal", kind) for _ in range(500)) >= MIN_REACTION_MS


def test_samples_follow_the_exported_human_distribution(tmp_path: Path) -> None:
    rng = random.Random(3)
    human = sorted(rng.lognormvariate(math.log(9000), 0.5) for _ in range(5000))
    quantiles = [human[round(p / 100 * (len(human) - 1))] for p in range(101)]
    path = tmp_path / "latency.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "minSamples": 200,
                "decisions": {"deal|stake": {"n": 5000, "quantiles": quantiles}},
                "typingMsPerChar": {"n": 0, "quantiles": []},
            }
        )
    )
    model = LatencyModel.load(path)
    assert not model.uses_prior("deal|stake")
    assert model.uses_prior("vote|vote")
    t = Timing(model, random.Random(4))
    sample = [t.decision_ms("deal", "stake") for _ in range(4000)]
    assert not t.used_prior
    assert ks_distance(sample, human) < 0.05


def test_small_buckets_fall_back_to_the_prior(tmp_path: Path) -> None:
    path = tmp_path / "latency.json"
    path.write_text(
        json.dumps(
            {
                "minSamples": 200,
                "decisions": {"invest|invest": {"n": 12, "quantiles": list(range(0, 101))}},
                "typingMsPerChar": {"n": 0, "quantiles": []},
            }
        )
    )
    model = LatencyModel.load(path)
    assert model.uses_prior("invest|invest")
    assert not model.fully_human
    t = Timing(model, random.Random(5))
    t.decision_ms("invest", "invest")
    assert t.used_prior


def test_typing_and_reading_take_time() -> None:
    t = Timing(LatencyModel(), random.Random(6))
    assert t.typing_ms("ok") >= 800
    assert t.typing_ms("who sent nothing last round") > t.typing_ms("ok")
    assert t.reading_ms("") == 0
