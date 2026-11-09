import { BotWorkspaceStore } from '../src/channels/shared/bot-workspace-store.mjs';
const path = 'C:/Users/nikol/.dsh/integrations/dsh-discord/workspaces.json';
const store = new BotWorkspaceStore(path, { defaultWorkspace: 'C:/AI' });
await store.load();
const botId = 'discord_7248f238f08ec6142b7bd229';
console.log(JSON.stringify({ bot: botId, busyMessageMode: store.busyMessageModeFor(botId) }));
