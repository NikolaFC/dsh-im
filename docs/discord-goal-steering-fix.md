# Discord steering across automatic goal rounds

Status: source implementation and local verification complete; integration build and runtime reload are owned by the parent task. No host restart or external test messages were performed.

## Root cause and consumed copy

Cordis Config inspection of `include:xmanrui-dsh-im` resolves `C:/Users/nikol/.dsh/profiles/desktop/node_modules/@xmanrui/dsh-im`, whose symlink target is `C:/AI/DSH/dsh-im`. Package entry is `lib/index.js`. Discord bot workspace config already sets `busyMessageModes.discord_7248f238f08ec6142b7bd229` to `steer`.

`BusyMessageDispatcher` attempts `steerMessage` before queuing. `HarnessClient` previously required a still-live `ask` ownership record with the exact prompt/turn. The ask retires that record when its turn finishes. An automatic goal round has `source.kind: goal`, a different turn, and no new Discord ask. Consequently steer returned false and the dispatcher queued the incoming message.

The game session `session-611e0f02-12db-48ff-bfa0-b1c590ce3279` demonstrates the distinction: turn 4 accepted Discord steer inputs; turn 5 began at seq 1990 with the goal input at seq 1993. Its prior Discord prompt was seq 1337 (`discord-77ca0ef2-f2c1-4f37-ad49-e61e2ff856a9`). A read-only replay of that actual history through the new executor with a stub agent accepted exactly one injection; no live session was mutated.

## Changes

- `src/channels/shared/harness-client.mjs`: retains exact route prompt anchors after ask completion; saves admitted anchors via host callbacks; allows only in-process goal continuation steering when normal ownership ends. No HTTP fallback for recovered goal controls.
- `plugin-src/host/harness-session-coordinator.mjs`: synchronously validates the original exact prompt and an uninterrupted series of same-goal turns immediately before injection. Manual turns, idle/closed sessions, mismatched prompts, cancelled rounds and changed goals are refused. Host context snapshots do not count as new human inputs.
- `src/channels/shared/conversation-state-store.mjs`: persists normalized `controlAnchors` in the bot-specific state file, keyed by native conversation/thread. Channel and session are checked. Rebind/clear invalidates anchors; binding version prevents an old in-flight ask from restoring an anchor after rebind away and back.
- `src/channels/shared/text-harness-bridge.mjs`: supplies server-side anchor callbacks at existing control sites. Permission/allowlist checks and pending-question guards remain in their existing paths. This file also contains the parallel goal-command agent's edits; preserve them.
- Tests: `test/channels/shared/harness-control.test.mjs`, `test/host-session-coordinator.test.mjs`, new `test/continuation-control-state.test.mjs`.

Stop/deferred-stop semantics are unchanged. Interaction, approval, group-history and artifact-consumer ownership are not inherited by goal rounds.

## Verification

Regression was observed red before implementation (completed ask -> goal round -> steer returned false). Final scoped run: **236 tests passed, 0 failed, 0 cancelled, 0 skipped**, exit 0. Covers client/control, synchronous host race/lineage refusal, durable reload, bot/channel/thread/session isolation, rebind ABA, dispatcher deduplication, all shared busy-message bridges, text bridge, and Discord runtime.

Command from the repository:

```powershell
node --import ../dsh-im-test-keepalive.mjs --test test/channels/shared/harness-control.test.mjs test/host-session-coordinator.test.mjs test/continuation-control-state.test.mjs test/deferred-turn-control.test.mjs test/busy-message-dispatcher.test.mjs test/channels/shared/busy-message-bridges.test.mjs test/channels/shared/text-harness-bridge.test.mjs test/channels/discord/discord.test.mjs
```

Test-only preload `C:/AI/DSH/dsh-im-test-keepalive.mjs` keeps a referenced interval until the `node:test` after hook. Existing production debounce/retry timers deliberately use `unref`; without a runner keepalive, the plain Node test command cancels pending timer tests with `Promise resolution is still pending but the event loop has already resolved`. Production timer code was not changed. Full captured final output: `C:/AI/DSH/dsh-im-steer-tests.log`. `git diff --check` passed.

## Remaining deployment and legacy limitation

Parent will build `lib/index.js` once parallel typing and goal-command changes are ready, then coordinate application to the active Host. A rebuilt file alone does not change already-instantiated client classes/private state. Cordis exposes plugin-manager enable/install lifecycle and reports `application`/restart reasons; no reload action was performed here.

New admitted prompts persist the anchor and recover it after reload. **The already-running legacy game has no persisted exact-route anchor**: its user event contains only text and a Discord-prefixed RPC id, and the old bot state has session bindings/latest authors/seen message IDs but no RPC-to-route proof. This implementation deliberately does not infer authority from a prefix or a present-day binding. It therefore cannot immediately recover steering of that old goal after reload. Establishing a fresh admitted Discord turn under the new runtime creates an anchor; a future explicitly authenticated goal-command anchoring protocol would need its own pre-mutation validation and rollback, and is outside this patch.

Related confirmed limit: `ask` closes outbound artifact consumer and group-history access in `finally`; automatic goal rounds lack that consumer. This patch does not claim to fix automatic-round file delivery.
