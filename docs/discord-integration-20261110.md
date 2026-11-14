# Discord fixes — 2026-11-10 handoff

## Current state
Source and Host bundle complete; user manually reloaded the plugin on 2026-11-10 (Discord message 1569639689969868861 at 09:07:44.584Z). Runtime activation is evidenced by the new production controlAnchor recorded for that admitted prompt, detailed below. Profile package resolves via symlink to C:/AI/DSH/dsh-im; built entry lib/index.js. Parent completed native command sync and Discord API readback: 15 commands, /goal id 1569638725904760857, exit 0 and no collisions. The manual reload's raw pluginManager ChangeResult was not captured.

## Verified
- Combined regression: 117 passed, 0 failed/cancelled. Evidence C:/AI/DSH/discord-integrated-20261110.tap. Command: node --import ../dsh-im-test-keepalive.mjs --test across goal-command, host-discord-activity, continuation-control-state, harness-control, host-session-coordinator, text-harness-bridge, discord, command-picker/interactions/help/permission tests.
- Host built with plugin-src/host/build.mjs; node --check lib/index.js passed; git diff --check clean.
- Pre-change bundle backup C:/AI/DSH/dsh-im-host-before-discord-fixes-20261110.js.
- Steer: route-specific admitted prompt anchors persisted per bot/conversation; uninterrupted goal lineage verified by host. Rebind/clear/ABA invalidate. Existing game session has NO historic durable anchor and cannot safely recover control just from Discord prefix. A new admitted normal Discord turn establishes future anchors. See discord-goal-steering-fix.md.
- Typing: real local parent/descendant/job activity; 7.5s heartbeat, no duplicate legacy loop, errors fall back to legacy. Pre-existing external runs without observable snapshot not inferred. Remote harnessBaseUrl retains legacy. See discord-activity-typing.md.
- /goal: native/shared status/create/pause/resume, binding fence and actor-scoped picker; host goals gateway uses inspected API. No actual user goal modified in tests. See bot-commands.md.

## Activation receipt and remaining acceptance

- Production state `C:/Users/nikol/.dsh/integrations/dsh-discord/bots/discord_7248f238f08ec6142b7bd229/state.json` now contains `controlAnchors.group:1468696025622380653`: channel `discord`, session `session-852ac050-e370-479e-b1cd-0164282e6740`, turn 54, promptRpcId `discord-e20b8188-4372-4c96-af8a-a5c97c06789a`. This is an actual new-code write, not merely a rebuilt-file check.
- Discord readback shows current repair progress message 1569639746702020751 created 09:07:58.110Z and edited 09:08:48.055Z. Game delivery message 1569639713021632573 arrived 09:07:50.080Z. These prove post-reload inbound processing/outbound delivery; no new connection error was observed in these sampled messages.
- The game route `group:1484533301195833446` still had no controlAnchor at verification; its latest admitted prompt was the pre-reload 08:59 turn. Do not claim legacy game goal-continuation steering is already covered.
- Remaining user-side acceptance: read-only native `/goal status` in the bound game channel; future newly admitted game turn followed by automatic goal continuation and steering; actual Discord typing while child/job alone runs and expiry after completion. No goal create/resume/pause was performed by this verification. No supported read-only command invocation was available to the verifier, so runtime goal-command output itself remains untested.

## Historical activation procedure
Installed HMR root=[]: build alone does not reload. Supported pluginManager.setBundleEnabled({name:'@xmanrui/dsh-im',enabled:true}) publishes/reconciles even if selected already. Use supported authenticated owner GUI/RPC, no fabricated endpoint. No plugin_manager tool in this session.

Reload is NOT lossless while IM turns are active: production close unregisters delivery, aborts runtime signal, closes gateway and artifact/group-history consumers, cancels pending questions. It may also pick up other changed linked packages. Do NOT activate mid-game/active deliveries. Wait for coordinated quiet boundary, then recompose or approved Desktop restart, verify actual runtime and Discord behavior. Only after activation run existing upsert-only scripts/sync-discord-native-commands.mjs, inspect registered /goal and exercise read-only status. Test ordinary turn -> automatic goal continuation -> incoming steer without waiting for whole turn. Verify typing with idle parent + active child/job and expiry after completion.

## Separate outstanding issue
Game screenshot was queued 08:12, actually delivered Discord 08:19:28 after turn end (message 1569627541398888570). Goal turns also lack artifact consumer/group-history inheritance. These delivery semantics were diagnosed but not changed by these three fixes.
