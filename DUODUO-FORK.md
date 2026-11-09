# duoduo fork of @xmanrui/dsh-im

Branch `duoduo`, based on upstream tag `v5.10.0` (origin = github.com/xmanrui/dsh-im).
The desktop profile loads it via `"@xmanrui/dsh-im": "link:C:/AI/DSH/dsh-im"`, so the
plugin page cannot overwrite it.

Changes (Discord only):
- `mentionFree` (bot config, default ON): every message addresses the bot, no @ needed,
  and replies stay in the source channel/thread instead of auto-creating a Thread.
- `thinkingTraces` (bot config, default ON): tool calls and reasoning lines go into one
  edited trace message (Discord subtext), then the answer is sent as its own message.
- Either switch is turned off with an explicit `false` on the bot in
  `~/.dsh/integrations/dsh-discord/config.json`.
- Trace formatters moved to `src/channels/shared/thinking-trace.mjs` (Telegram re-exports).

After editing: `npm run build`, run `test/channels/discord/*.test.mjs`, commit, then
toggle the plugin off/on (or restart DSH) so the host reloads `lib/index.js`.

Upgrading: `git fetch --tags origin`, `git rebase <new tag>` (or cherry-pick the duoduo
commits), `npm ci`, build, test.
