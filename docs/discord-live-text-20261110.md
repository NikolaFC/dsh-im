# Live assistant text in Discord (and WeChat) — 2026-11-10

Status: source, tests and Host bundle done. Not reloaded, no messages sent. The user reloads manually.

## Root cause

Evidence: session `session-3fbf36f9-…`, bound to Discord channel 1484533301195833446. Its turn 4 wrote narrative text in steps 17, 28, 31 and 50. Each of those `assistant/message` events had `reasoning,text,tool-call` content. None of the text reached Discord until the user ran /stop (turn/end `aborted` 14:37:23.119Z). It then arrived as one message, 1569722649070800988.

1. `src/channels/shared/text-harness-bridge.mjs` (thinking mode, the Discord default): the `onUpdate` handler forwarded only `reasoning` (💭) and `tool` (🔧) updates to the trace stream. It dropped `text` and `assistant-message` updates (old lines ~1378-1386).
2. `src/channels/shared/harness-client.mjs`: `ask()` returns the whole-turn accumulator. `HarnessReplyTracker.answer` / `finalAnswer` joins every step's text (old lines 643-649). That value is returned at turn end (old 2315), or on the stop path (old 2385). The bridge then sends it once through `stream.finish()`.
3. Goal rounds: `plugin-src/host/session-sync-coordinator.mjs` keeps only the text after the last tool call (`accumulateFinalAssistantText`) and delivers at `turn/end`. A Discord **steer** into a goal round registered its rpcId as an IM input origin (`harness-client.mjs` steer path). The coordinator therefore classified the whole goal round as IM-owned. Nobody delivered that round's answer at all (session 3fbf36f9 turn 2: goal + `discord-steer-…`).

## Change

- Tracker (`harness-client.mjs`):
  - An `assistant-message` update now carries `toolCalls: true` when its content has a tool-call part.
  - `AssistantTextAccumulator.textExcluding(steps)` and `HarnessReplyTracker.answerExcluding` / `finalAnswerExcluding` were added.
  - `ask()` accepts `liveDeliveredSteps` (a `Set`) and leaves those steps out of the returned answer, on both the completion and the /stop paths. A succeeded turn whose text all went out live returns `''`.
- Bridge (`text-harness-bridge.mjs`): new option `liveText` (default false; Discord passes it). It needs a thinking stream with `sendSegment`.
  - A step's text is held until that step is known not to be final: it called a tool, or a later step started.
  - The held text is then posted right after that step's 💭 line, so the order is 💭 → text → 🔧.
  - A step counts as posted only after a successful send. A failed send stays in the final message.
  - When nothing is left at turn end, the stream closes with `{ liveSegmentsOnly: true }` instead of posting a placeholder.
- Discord stream (`discord-runtime.mjs`, `openThinkingStream`):
  - New `sendSegment(block)` goes through the same write chain. Pending trace lines are flushed first, and later trace lines open a new page below the segment.
  - It uses the existing `#sendText` path: markdown chunks of 1900 characters. Only the first message of a turn replies to the user's message.
  - Segment ids count in `providerMessageIds`. `finish({liveSegmentsOnly})` sends nothing when segments were posted.
- Config:
  - `liveText` is a bot switch, default ON. An explicit `false` in `~/.dsh/integrations/dsh-discord/config.json` turns it off; `config-store.mjs` persists it like `thinkingTraces`.
  - The runtime registers its bot in `session-sync-registry.mjs` (`registerLiveSegmentBot`) while connected.
- Goal rounds and other service turns (`session-sync-coordinator.mjs`):
  - An `assistant/message` with text plus a tool call is delivered at once, under the existing `deliverModelAnswers` rules and with the model icon.
  - It is delivered **only** to targets or bindings whose bot is a registered live-segment bot. Other channels and bots keep receiving the final answer only.
  - The accumulator already drops that text at the tool call, so the final message never repeats it.
- Steers: steer inputs are registered as steers (`isDshImSteerInput`). The coordinator receives them as `im-steer`, which never claims or echoes a turn. A steered goal round therefore stays a service turn and gets its segments plus its final answer.
- Steered IM turns: the steer lands in the running ask, whose tracker covers the new steps.

## Tests

- New: `test/channels/discord/live-text.test.mjs` (11 tests):
  - tracker flags and exclusion
  - Discord segment ordering, splitting and `liveSegmentsOnly`
  - a replay of the real turn shape through `DiscordHarnessBridge`, plus the stop, failed-send and `liveText=false` cases
  - config persistence
  - the goal-round coordinator, the steer origin and registry isolation
- New: two `ask()` tests in `test/channels/shared/harness-apiproxy.test.mjs`. A posted step is excluded, and an all-posted turn answers `''`.
- Focused run of 25 files (all Discord, shared bridge and client, session sync, Feishu/Telegram consumers of `assistant-message`, plus the earlier 117/276 sets): **570 tests, 569 pass**. The 1 failure is pre-existing and unrelated, `test/host.test.mjs` "Host waits for modern Harness Controllers". It expects `sessionController` to be injected first, but committed 5c6a64e5 injects `tools` first. Log: `C:/AI/DSH/dsh-im-live-text-tests.tap`.
- Full run (310 files): 4982 pass, 8 fail, 1 cancelled. None of these touch the changed code:
  - the same host test
  - catalog/help tests broken by the pending `/goal` catalog edits (4 tests, plus Feishu panel `/goal`)
  - `delivery-sync-settings` file size
  - `delivery-service.test.mjs`, whose test at line 257 is nested inside an unclosed test and gets cancelled
  
  Log: `C:/AI/DSH/dsh-im-live-text-full.tap`.
- Command: `node --import ../dsh-im-test-keepalive.mjs --test <files>` from `C:/AI/DSH/dsh-im`.

## Build and deploy

- Backup: `C:/AI/DSH/dsh-im-host-before-streaming-20261110.js` (same sha256 as the pre-build bundle, 3D28100C…).
- `node plugin-src/host/build.mjs` → exit 0. `node --check lib/index.js` → exit 0. `git diff --check` is clean.
- Deploy: reload the `@xmanrui/dsh-im` bundle (plugin off/on, or restart DSH) at a quiet boundary. As before, a reload aborts in-flight IM turns. Opting out needs `"liveText": false` on the bot, then a reload.
- Rollback: copy the backup over `lib/index.js` and reload.

## WeChat

WeChat on this machine is **not** dsh-im. It is `@local/dsh-duoduo-weixin` (`C:/AI/DSH/weixin-bridge`, profile dependency `link:C:/AI/DSH/weixin-bridge`, row `duoduo-weixin`). Its tool is `weixin_connection`; its session is "钱多多 · 微信" `session-544a4036-…`, whose prompts carry `weixin-<id>` rpcIds. dsh-im has no weixin bot configured; `~/.dsh/integrations` holds only `dsh-discord` and `dsh-im`.

Its old behaviour: `bridge.mjs` `deliver()` waited for the idle session, then sent only `finalReply()`, the last non-tool assistant message. Text written before tool calls was never sent at all. For example, that session's turn 4 had more than 20 such steps.

The change in `bridge.mjs` and `index.js`:

- **Live segments.** While waiting, it peeks every 2.5 s (`peekRecords` over `sessions.state` plus `sessions.events`; read-only, never waits). It posts each text+tool-call step of the item's own turn as its own plain-text message. The turn is found via the `weixin-<id>` user/message.
- **Pacing.** There are at least 1.5 s between any two outgoing messages, and 1800-character splitting is kept.
- **Final pass.** After the turn settles, a final pass sends any segment the polling missed, then the unchanged final answer. The final answer is never a tool step, so it is never duplicated.
- **Dedup and crash safety.** Segment dedup keys are `turn:step`, persisted in `item.segments`. A segment interrupted by a crash (`segmentSending`) counts as sent and is never resent. Unlike the final reply, it does not block the item.
- **Failures.** A failed or rate-limited segment is recorded in `lastError` and not retried, and the final reply still goes out.

Tests: 37/37 (`node --test ilink.test.mjs bridge.test.mjs index.test.mjs`; 32 before, plus 5 new). Backup of the pre-change files: `C:/AI/DSH/weixin-bridge-before-live-text-20261110/`. There is no build step: the plugin loads `index.js` directly. It does not hot-reload. Reload it via plugin off/on or a DSH restart, while `weixin_connection status` shows `pending: []`, because a reload during a send marks it DELIVERY_UNCERTAIN.

## Limitations

- Deferred delivery after a `harness-reply-timeout` and session-reply recovery after a restart still rebuild the answer from history. They may repeat segments that were already posted live.
- If a Discord segment send fails, its text stays in the final message. A partially sent multi-chunk segment can then appear partly twice.
- A goal-round segment that fails is not repeated in that round's final, which is the old behaviour for pre-tool text.
- Goal-round segments only flow while the Discord runtime is connected and registered, and only if `deliverModelAnswers` is on.
- A steer into a Web-GUI turn no longer suppresses that turn's sync delivery.
- WeChat: many tool steps mean many WeChat messages, which can trigger iLink rate limits (`-2`). Those segments are skipped, never retried.
- No live acceptance yet. That needs the user's reload and a real turn.
