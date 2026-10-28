"""CLAUDE.md invariant 13 and DECISIONS "Agents asked if they are a bot": the output filter."""

import pytest

from canutell_agents.chat import _DEFLECT, _DM, _OPENERS
from canutell_agents.safety import check

BLOCK = {
    "contact_details": [
        "add me bob@example.com",
        "check www.mysite.net",
        "join discord.gg/abc",
        "text 555 123 4567",
        "im @coolguy99 there",
        "see https://evil.example/x",
    ],
    "personal_info_request": [
        "whats your name?",
        "how old are u",
        "where do you live",
        "where are you from",
        "drop ur insta",
        "tell me your real name",
        "are you a girl",
    ],
    "off_platform_invite": [
        "add me on discord after",
        "lets chat somewhere else",
        "we should meet irl",
        "hit me up later",
        "you on whatsapp?",
    ],
    "identity_claim": [
        "my name is sam",
        "call me Max",
        "I'm Jane Doe btw",
        "im 24 years old",
        "i live in madrid",
    ],
    "denies_being_ai": [
        "im human lol",
        "I'm definitely a real person",
        "i'm not a bot",
        "100% human here",
        "trust me im not an ai",
        "human here, relax",
    ],
}

PASS = [
    "lol thats exactly what a bot would ask",
    "you'll find out at the reveal",
    "who sent nothing last round",
    "i think seat 3 is the bot",
    "are you a bot? you invest like one",
    "returning your stake now",
    "ok 20 from me this round",
    "nice try",
    "roles get revealed at the end of the match",
]


@pytest.mark.parametrize(("reason", "text"), [(r, t) for r, ts in BLOCK.items() for t in ts])
def test_blocks(reason: str, text: str) -> None:
    ok, why = check(text)
    assert not ok
    assert why == reason, (text, why)


@pytest.mark.parametrize("text", PASS)
def test_passes(text: str) -> None:
    assert check(text) == (True, None)


def test_format_limits() -> None:
    assert check("") == (False, "empty")
    assert check("a" * 201) == (False, "format")
    assert check("two\nlines") == (False, "format")


def test_every_scripted_line_passes_the_filter() -> None:
    for line in [*_OPENERS, *_DEFLECT, *_DM]:
        assert check(line) == (True, None), line
