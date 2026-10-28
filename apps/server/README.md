# apps/server — placeholder

Server-authoritative Node game server (WebSockets, matchmaking, timers). Built in **Phase 2**.
Runs on a host with persistent processes, not serverless. It will drive `@canutell/engine`:
`createMatch` → `advancePhase` on a timer → `applyAction` for each validated client choice.
