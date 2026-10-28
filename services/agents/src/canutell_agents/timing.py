"""Human-like response timing (CLAUDE.md invariant 14: sampled from the human latency distribution for that
phase, never instant).

The distribution comes from `pnpm db:latency-model`, which exports aggregate quantiles of eligible human
latencies per (phase, decision kind). Eligible means consented T2+ human seats only (invariant 10), so until
Phase 5 the export is empty. Any bucket with fewer than `minSamples` samples falls back to the documented
PRIOR below, and the session reports `latency_prior` so the match is flagged (DECISIONS "Agent timing").
"""

from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# ---- Placeholder prior (no human data yet). Log-normal per decision kind: median ms, sigma. ----
# Chosen to be plausible for a 15-60 s phase on a phone: quick for one-tap choices, slower for multi-field
# forms. It is a stand-in only; matches using it are flagged and real data replaces it automatically.
PRIOR: dict[str, tuple[float, float]] = {
    "invest": (8_000, 0.55),
    "stake": (17_000, 0.55),
    "return": (11_000, 0.6),
    "gamble": (5_500, 0.5),
    "vote": (11_000, 0.55),
    "ballot": (24_000, 0.45),
}
#: Never answer faster than this (ms), whatever the source: a human has to read the prompt.
MIN_REACTION_MS = 1_200
#: Typing speed prior, ms per character (~55 wpm with pauses).
PRIOR_TYPING_MS_PER_CHAR = (210.0, 0.35)
#: Reading speed, ms per word of new chat to read before replying.
READ_MS_PER_WORD = 240.0


@dataclass
class LatencyModel:
    min_samples: int = 200
    buckets: dict[str, list[float]] = field(default_factory=dict)  # key "phase|kind" -> 101 quantiles
    bucket_n: dict[str, int] = field(default_factory=dict)
    typing_quantiles: list[float] = field(default_factory=list)
    typing_n: int = 0

    @staticmethod
    def load(path: str | Path | None) -> LatencyModel:
        if path is None or not Path(path).exists():
            return LatencyModel()
        data: dict[str, Any] = json.loads(Path(path).read_text())
        model = LatencyModel(min_samples=int(data.get("minSamples", 200)))
        for key, b in data.get("decisions", {}).items():
            model.bucket_n[key] = int(b["n"])
            model.buckets[key] = [float(q) for q in b["quantiles"]]
        typing = data.get("typingMsPerChar", {"n": 0, "quantiles": []})
        model.typing_n = int(typing["n"])
        model.typing_quantiles = [float(q) for q in typing["quantiles"]]
        return model

    def uses_prior(self, key: str) -> bool:
        return self.bucket_n.get(key, 0) < self.min_samples or len(self.buckets.get(key, [])) != 101

    @property
    def fully_human(self) -> bool:
        """True when every decision kind in every phase it occurs in is backed by real human data."""
        return bool(self.buckets) and not any(self.uses_prior(k) for k in self.buckets)


def _from_quantiles(q: list[float], rng: random.Random) -> float:
    """Inverse-CDF sample by linear interpolation between the 101 exported quantiles."""
    u = rng.random() * 100
    lo = math.floor(u)
    hi = min(100, lo + 1)
    return q[lo] + (q[hi] - q[lo]) * (u - lo)


class Timing:
    """One per agent session (its own RNG). Records whether any sample came from the prior."""

    def __init__(self, model: LatencyModel, rng: random.Random) -> None:
        self.model = model
        self.rng = rng
        self.used_prior = False

    def decision_ms(self, phase: str, kind: str) -> float:
        key = f"{phase}|{kind}"
        if self.model.uses_prior(key):
            self.used_prior = True
            median, sigma = PRIOR[kind]
            ms = median * math.exp(self.rng.gauss(0.0, sigma))
        else:
            ms = _from_quantiles(self.model.buckets[key], self.rng)
        return max(float(MIN_REACTION_MS), ms)

    def typing_ms(self, text: str) -> float:
        if self.model.typing_n >= self.model.min_samples and len(self.model.typing_quantiles) == 101:
            per_char = _from_quantiles(self.model.typing_quantiles, self.rng)
        else:
            self.used_prior = True
            median, sigma = PRIOR_TYPING_MS_PER_CHAR
            per_char = median * math.exp(self.rng.gauss(0.0, sigma))
        return max(800.0, per_char * len(text))

    def reading_ms(self, new_text: str) -> float:
        words = len(new_text.split())
        return words * READ_MS_PER_WORD * math.exp(self.rng.gauss(0.0, 0.3))
