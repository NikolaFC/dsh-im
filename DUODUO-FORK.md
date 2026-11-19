# duoduo fork of @xmanrui/dsh-im

Branch `duoduo` is based on upstream release `v5.10.0`. The public fork is [NikolaFC/dsh-im](https://github.com/NikolaFC/dsh-im) and the [upstream project](https://github.com/xmanrui/dsh-im) is xmanrui/dsh-im.
The desktop profile loads it via `"@xmanrui/dsh-im": "link:C:/AI/DSH/dsh-im"`, so the
plugin page cannot overwrite it.

Changes (Discord only):
- `mentionFree` (bot config, default ON): every message addresses the bot, no @ needed,
  and replies stay in the source channel/thread instead of auto-creating a Thread.
- `thinkingTraces` (bot config, default ON): tool calls and reasoning lines go into one
  edited trace message (Discord subtext), then the answer is sent as its own message.
- `liveText` (bot config, default ON): assistant text written in a step that then calls a
  tool is posted at once as its own message; the turn-end message carries only the rest.
  Goal rounds delivered through Session sync get the same treatment for opted-in bots.
  See `docs/discord-live-text-20261110.md`.
- Any switch is turned off with an explicit `false` on the bot in
  `~/.dsh/integrations/dsh-discord/config.json`.
- Trace formatters moved to `src/channels/shared/thinking-trace.mjs` (Telegram re-exports).
- `/goal` (Host goal service, shared by the text channels and Feishu): `/goal <objective>`
  is the short form of `/goal create <objective>`; `status`/`pause`/`resume` keep their
  meanings. Creation on a conversation with no binding — a new channel or thread, or right
  after `/new` — opens and binds the Session the same way an ordinary first message does,
  so an objective can be set before the first prompt. Feishu gained the panel entry and
  the handler it was missing.

After editing: `npm run build`, run `test/channels/discord/*.test.mjs`, commit, then
toggle the plugin off/on (or restart DSH) so the host reloads `lib/index.js`.

Upgrading: `git fetch --tags upstream`, `git rebase <new tag>` (or cherry-pick the duoduo
commits), `npm ci`, build, test.

## Public sync

Use a checkout of the public fork for publication. Apply reviewed source and test changes as patches to its `duoduo` branch and regenerate the package bundles there. Keep the original desktop checkout and its history local. Keep live acceptance captures, private conversation transcripts and local probe output in the workspace. Use synthetic fixtures and redacted verification notes in public commits. Check the complete outbound history before pushing, including files deleted later.
