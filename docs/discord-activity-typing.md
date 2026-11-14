# Discord active-work typing (local fork)

## Diagnosis — 2026-11-10

The built bundle contains the observer, and production wires it only for the local Harness (`plugin-src/host/channels/discord/production.mjs`). Both persisted routes were verified: `group:1468696025622380653` -> `session-852ac050-e370-479e-b1cd-0164282e6740`, `group:1484533301195833446` -> `session-3fbf36f9-fbcb-47c4-9f6e-60f6a0d4b458`. Bot config has no remote Harness URL. `state.snapshot()` exposes those bindings; the workspace-scoped `sessionFor()` revalidates them.

The old transport suppressed legacy turn typing whenever the observer returned a disposer (`discord-runtime.mjs`, previous lines 514–526, 930–943). That made an attached observer which derived no busy route a single point of failure. Missing services returned null and lifecycle errors normally restored legacy typing via onStop; those paths did NOT unconditionally suppress it. Existing local Agents and jobs were already hydrated, so missing a local child creation event alone was not a demonstrated cause.

Confirmed coverage defect: external subagents only entered activity through a start event; reloading during an external run lost its activity. The installed public `subagents.listDescendants()` reports activity by local Session residency, but external activations have no Session. It is not a valid external liveness source. The observer now uses a guarded, read-only compatibility adapter over the inspected installed `subagents.manager.resident` Map, accepting only external activations with an exact live parent object. Unknown shapes yield explicit unavailable coverage and never invent activity from history.

**The precise cause of the reported current outage is not proven.** Pre-fix runtime exported no observer instance diagnostic. Inspect APIs confirmed contracts, not the in-memory loaded bundle or `activityTyping` value. No reload, restart, or real Discord send was permitted/performed. File freshness cannot establish what the current process loaded. The next approved reload and diagnostic snapshot distinguish missing attachment, route exclusion and transport failures.

## Fix

- Legacy turn typing is always active; activity typing is additive. `DiscordBotClient` owns one shared per-channel 7,500 ms gate and in-flight guard, with 5-second request cancellation. No double sends from the two producers. The observer aligns its next timer to the transport's actual attempt time when legacy wins the gate, avoiding a 15-second skipped-heartbeat gap.
- The observer watches inspected `agent/created`, `agent/status`, `agent/disposed`, parent-scoped `subagent/start/end`, and `jobs.events.subscribe({owner})`. `agents.isOwnedBy` links exact live owners; missing ownership support degrades descendant coverage while preserving foreground work. All callbacks and disposers contain failures.
- Startup re-derives live Agent status, owned running/stopping jobs and external activation ownership. Every pulse revalidates `snapshot().sessions` through scoped `sessionFor()`, including thread IDs and workspace changes. Goal continuation executes as an ordinary running Agent; a dormant/paused goal alone never counts as work.
- A coalesced atomic diagnostic snapshot is written on reconcile, send settlement, attach failure and disposal to `<botsDir>/<botId>/discord-typing.json` alongside that bot's state. Fields: `at`, `pid`, `attached`, `reason`, `busySessions`, `channels`, `lastPulseAtByChannel` (attempt time), `errors`, `externalCoverage`. Arrays/maps are capped at 500 entries, errors at 16 sanitized codes. No task, label, output, prompt or token content. Disk failure is contained and logs a fixed warning.
- External coverage reports `live-manager` or `unavailable(manager-resident|activation-shape|read-failed)`. This seam is version-sensitive and deliberately fail-soft. Remote Harness uses legacy typing with reason `remote-harness`.

## Coverage matrix

| Work/state | Typing | Startup recovery |
| --- | --- | --- |
| Own foreground turn, foreground tool/job | Yes | Live Agent status + owned jobs |
| Parent-owned background job, including stopping | Yes until terminal | jobs.list(parent) |
| Local child/deeper descendant and its jobs | Bound ancestor channels | agents.list + exact isOwnedBy links |
| External provider activation | Parent/ancestor channels | Guarded live activation Map; explicit degradation on incompatible runtime |
| Goal continuation round | Yes while Agent running | Live Agent status |
| Idle resident child, dormant/paused goal, queued inbox only | No | Never infer work from persistence |
| Unrelated session/fork/unowned job | No | Process-local exact ownership only |
| Unbound or workspace-masked conversation | No | Scoped binding checked each dispatch |
| Observer unavailable/stopped | Legacy foreground path remains | No suppressing mode switch |

Discord has no stop-typing endpoint. Once all work ends, no new pulses are sent; the UI expires its last indicator after about ten seconds. No chat status messages are posted.

## Tests and build

From `C:/AI/DSH/dsh-im`:

```text
node --import ../dsh-im-test-keepalive.mjs --test test/host-*.test.mjs test/channels/discord/*.test.mjs
node plugin-src/host/build.mjs
node --check lib/index.js
```

The bounded test import prevents existing unreferenced Discord retry timers from causing isolated suites to cancel. Tests cover real foreground state, running/idle goal-round edges, parent and child jobs, deep ownership, external hydration/restart/settlement, malformed external runtime shape, route masking, failures, diagnostic disk writes, shared transport rate limit, timer alignment, and disposal. All HTTP/typing calls in tests are mocks.

The existing bundle and WeChat bridge were backed up under `C:/AI/DSH/im-typing-backup-20261110-151856/` before build. The dirty workspace includes prior streaming/control work, which remains preserved.

## Reload requirement and acceptance

**Not live until the Host loads the new bundle.** Reload `@xmanrui/dsh-im` only when separately authorized; do not assume a Web refresh loads Host code. Read the new diagnostic at `C:/Users/nikol/.dsh/integrations/dsh-discord/bots/discord_7248f238f08ec6142b7bd229/discord-typing.json`: it should have the current PID/time, `attached:true`, the busy bound session and channel, then progressing pulse timestamps. Check UI typing during foreground, idle-parent/child and job-only work; confirm no pulses once all stop. A transport error remains distinguishable from observer attachment. Real network success/UI visibility was not tested in this repair.

## WeChat protocol correction

The independent `C:/AI/DSH/weixin-bridge` previously had no typing implementation. **iLink itself does support typing**: POST `/ilink/bot/getconfig` returns `typing_ticket`; POST `/ilink/bot/sendtyping` accepts `ilink_user_id`, `typing_ticket`, status 1 (start) / 2 (stop). This is evidenced by the existing dsh-im Weixin adapter, not a live account probe. The independent bridge now implements these endpoints with ticket cache/expiry and bounded best-effort stop. Its separate optional progress lines expose only tool identifiers, at most one per four seconds, with dedupe and no retry on rate limits. Both switches default on. See that bridge's `ACTIVITY.md`; it has no build step and requires its own separately authorized plugin reload.
