# Discord `/goal` on a fresh conversation

Status: source fix complete, tests and bundle built. The running Host still holds the
previous `lib/index.js`, so the change takes effect after a plugin reload (plugin page
off/on) or a DSH restart. No live Discord message was sent during diagnosis.

## Reported symptom

On 2026-11-13 Satoshi opened a new Discord conversation and ran `/goal create …`; the bot
answered that the chat has no bound session, and every later attempt repeated it — in his
words, `/goal` was unusable.

## Root cause

`runGoalCommand` read `state.sessionFor(key)` and, with no binding, returned the unbound
notice immediately. An ordinary first message goes through `askInWorkspaceSession`, which
creates and binds the conversation's Session. A new channel or thread, and a chat just
reset by `/new` (`startNewConversation` clears the binding), have no binding yet, so the
natural order — open a conversation, set the goal, then start — was impossible.

The Discord help panel made it look worse: the "会话目标" picker is built from
`/goal status`, so on an unbound chat it repeated the same notice while still offering
「创建目标（填写说明）」, whose press only re-rendered the notice path.

## Changes

- `src/channels/shared/goal-command.mjs`: `/goal <objective>` is now the short spelling of
  `/goal create <objective>` (default 256-round cap); `status`/`pause`/`resume` keep their
  meanings, and `create` stays available for an objective that starts with one of them or
  needs `--rounds`. `create` on an unbound conversation opens the Session the same way an
  ordinary first message does — `harness.createSession({ conversationKey, signal })` inside
  `withSessionBindingLock`, then `state.setSession`. A concurrent creation is reused instead
  of orphaned, a failed creation leaves no binding, and a moved workspace raises
  `workspace-session-stale`. `status`/`pause`/`resume` keep requiring a binding; no command
  falls back to the global or latest Session.
- `src/channels/feishu/bridge.mjs` + `slash-command-panel.mjs`: Feishu had goal-round
  display but no `/goal` entry, so the command was neither in its panel nor handled —
  a typed `/goal …` would have been sent to the model as a prompt. It is now in the panel
  and dispatched to the same shared handler.
- `src/channels/discord/discord-command-picker.mjs`: the unbound goal panel appends the
  create hint (by constant, not a copied literal), so the card says how to create the goal
  instead of only that the chat is unbound.
- `docs/bot-commands.md`, `DUODUO-FORK.md`: record the behaviour.
- `test/goal-command.test.mjs`: short-form grammar; unbound create binds and submits;
  unbound reads open nothing; a failed creation neither binds nor submits; the unbound
  picker offers creation and its hint.

## Verification

```
node --import ../dsh-im-test-keepalive.mjs --test test/goal-command.test.mjs \
  test/channels/discord/discord-command-picker.test.mjs \
  test/channels/shared/command-help.test.mjs test/channels/shared/i18n-coverage.test.mjs
```

37 tests passed, 0 failed. `npm run build` rewrote `lib/index.js` and `lib/client.js`;
`scripts/verify-package.mjs` passed.

Full suite: 5008 tests, 5002 passed, 0 failed, the rest skipped/todo. The seven failures
left by the previous task are gone:
- four Telegram menu/help expectations now carry the `goal` entry (help line count 30 → 32,
  `/help` fixture updated for the short creation spelling);
- the Feishu panel now registers `/goal` and its bridge dispatches it, with the manifest
  and registration counts updated (31 → 32 entries, counts 20 → 21, 35 → 36);
- `delivery-sync-settings` asserts the 0600 intent only off Windows, where POSIX mode bits
  do not exist;
- `host.test.mjs` looks for the controller injection among all injections instead of
  assuming it is the first, since Discord thread/management tools now inject earlier.

## Not claimed

The runtime copy is only verified after the reload. A Session opened by `/goal` still has
no conversation title of its own (the first ordinary message path sets one).
