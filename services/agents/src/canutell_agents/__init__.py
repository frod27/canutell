"""CANUTELL Baseline agents (SPEC §Agents, class Baseline).

An agent is a player that connects through the same WebSocket protocol as humans (CLAUDE.md invariant 15),
decides with a fast decision model that reports a confidence, chats through an LLM behind a safety filter
(invariant 13), and times every response from the human latency distribution (invariant 14).
"""

AGENT_VERSION = "baseline-1"
