-- 0005_baseline_chat_haiku.sql — approved 2026-10-29 (DECISIONS "Chat model: Haiku 5.5").
-- Corrects the description of baseline-1's chat model: the owner switched agent chat to Claude Haiku 5.5.
-- Data affected: one descriptive text field of one agent_versions row. Nothing else changes; matches and
-- seats keep their agent_version. Every baseline-1 match before the switch is dev data (phase4/phase5).

update agent_versions
   set chat_model = 'claude-haiku-5-5 by default (AGENT_CHAT_MODEL); scripted lines when no API credential; '
                 || 'claude-opus-5-5 before 2026-10-29 (dev data only)'
 where agent_version = 'baseline-1';
