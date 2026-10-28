"""Deterministic output filter for agent chat (CLAUDE.md invariant 13, SPEC §Agents).

An agent message is dropped — never retried into something similar — if it:
  * contains contact details or links (the engine's own masking patterns, ported),
  * asks anyone for personal information,
  * invites anyone off-platform,
  * claims to be a specific real person (states a name or identity), or
  * flatly claims to be human / denies being an AI (DECISIONS "Agents asked if they are a bot": deflect,
    never deny).
The patterns are deliberately broad: a dropped harmless line costs nothing; a leak or a lie is the failure.
Run as `python -m canutell_agents.safety` to check JSON lines of {"text": ...} from stdin.
"""

from __future__ import annotations

import json
import re
import sys

MAX_LEN = 200

# Ported from packages/engine/src/mask.ts (contact details are masked in human chat; agents never send them).
_CONTACT = [
    re.compile(
        r"[A-Za-z0-9._%+-]+\s*(?:@|\(at\)|\[at\])\s*[A-Za-z0-9-]+(?:\s*(?:\.|\(dot\)|\[dot\])\s*[A-Za-z0-9-]+)+",
        re.I,
    ),
    re.compile(r"\b(?:https?|ftp)://\S+", re.I),
    re.compile(r"\bwww\.\S+", re.I),
    re.compile(
        r"\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|net|org|io|co|me|app|gg|xyz|info|biz|dev|ly|tv|us|uk|es|"
        r"de|fr|ru|in|ai|link|club|site|online|chat)\b(?:/\S*)?",
        re.I,
    ),
    re.compile(r"\b(?:discord\.gg|t\.me|wa\.me)/\S+", re.I),
    re.compile(r"\+?\d(?:[\s().\-/]*\d){6,}"),
    re.compile(r"(?<!\w)@[A-Za-z0-9_.]{3,}"),  # social handles
]

_PERSONAL_INFO = [
    re.compile(
        r"\b(what('?s| is)|tell me|give me|share|send( me)?|drop)\s+(your|ur|yo)\s+(real\s+)?"
        r"(name|age|address|number|phone|email|e-mail|insta|instagram|snap|snapchat|discord|whatsapp|"
        r"telegram|location|city|school|job|handle|socials?|tiktok|twitter|facebook)\b",
        re.I,
    ),
    re.compile(r"\bhow old (are|r) (you|u)\b", re.I),
    re.compile(r"\bwhere (do|d) (you|u) (live|work|go to school)\b", re.I),
    re.compile(r"\bwhere (are|r) (you|u) (from|located|based)\b", re.I),
    re.compile(r"\b(your|ur) (real |full |last )?name\b", re.I),
    re.compile(r"\b(are|r) (you|u) (a )?(guy|girl|man|woman|male|female|single)\b", re.I),
]

_OFF_PLATFORM = [
    re.compile(
        r"\b(discord|whatsapp|telegram|snapchat|snap|insta|instagram|tiktok|twitter|facebook|signal|kik|skype|"
        r"zoom|google meet|reddit|twitch|steam|messenger|imessage)\b",
        re.I,
    ),
    re.compile(
        r"\b(add|dm|message|text|call|find|follow|hit|reach|contact)\s+me\s+(on|at|up|outside|later|after)\b",
        re.I,
    ),
    re.compile(r"\b(off[- ]?platform|another app|outside (the|this) (game|app)|after the game,? (let'?s|we))\b", re.I),
    re.compile(r"\blet'?s (talk|chat|meet|connect|play) (somewhere|elsewhere|outside|privately|irl|later)\b", re.I),
    re.compile(r"\b(meet|meet up|hang out) (irl|in person|in real life)\b", re.I),
]

_IDENTITY_CLAIMS = [
    re.compile(r"\bmy name('?s| is)\b", re.I),
    re.compile(r"\b(call me|i go by)\s+[A-Za-z]", re.I),
    re.compile(r"\b(?i:i am|i'm|im|this is)\s+(?:the\s+)?[A-Z][a-z]+\s+[A-Z][a-z]+\b"),  # "I'm Jane Doe"
    re.compile(r"\b(i am|i'm|im)\s+(a |an )?\d{1,2}\s*(yo|y/o|years? old)\b", re.I),
    re.compile(r"\bi (live|work|study) (in|at)\b", re.I),
]

# Never flatly claim to be human or deny being an AI. Playful deflection is fine.
_DENIES_AI = [
    re.compile(
        r"\b(i am|i'm|im|i'?m just)\s+(definitely\s+|totally\s+|100% |a\s+|an\s+|really\s+|real\s+|actually\s+)*"
        r"(human|person|people|real person|not (a |an )?(bot|ai|robot|agent|machine|computer))\b",
        re.I,
    ),
    re.compile(
        r"\b(not|never) (an? )?(bot|ai|robot)\b.*\b(me|i)\b|\b(me|i)\b.*\b(not|never) (an? )?(bot|ai|robot)\b",
        re.I,
    ),
    re.compile(r"\b(100|1000)\s*%\s*human\b", re.I),
    re.compile(r"\bi('?m| am) (flesh and blood|a real one)\b", re.I),
    re.compile(r"\bhuman here\b", re.I),
]

_CATEGORIES: list[tuple[str, list[re.Pattern[str]]]] = [
    ("contact_details", _CONTACT),
    ("personal_info_request", _PERSONAL_INFO),
    ("off_platform_invite", _OFF_PLATFORM),
    ("identity_claim", _IDENTITY_CLAIMS),
    ("denies_being_ai", _DENIES_AI),
]


def check(text: str) -> tuple[bool, str | None]:
    """(ok, reason). `reason` names the first rule a blocked message broke."""
    if not text or not text.strip():
        return False, "empty"
    if len(text) > MAX_LEN or "\n" in text:
        return False, "format"
    for name, patterns in _CATEGORIES:
        for pattern in patterns:
            if pattern.search(text):
                return False, name
    return True, None


def main() -> int:
    """Read JSON lines {"text": ...}; print any that fail. Exit 1 if any fail."""
    bad = 0
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        text = json.loads(line)["text"]
        ok, reason = check(text)
        if not ok:
            bad += 1
            print(json.dumps({"text": text, "reason": reason}))
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
