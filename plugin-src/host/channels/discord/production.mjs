import { DiscordConfigStore } from '../../../../src/channels/discord/config-store.mjs';
import { DiscordController } from '../../../../src/channels/discord/discord-controller.mjs';
import { DiscordHarnessClient } from '../../../../src/channels/discord/harness-client.mjs';
import { DiscordRuntime } from '../../../../src/channels/discord/discord-runtime.mjs';
import { DiscordStateStore } from '../../../../src/channels/discord/state-store.mjs';
import { createTokenProductionController, pluginPaths } from '../shared/production.mjs';
import { observeDiscordActivity, createTypingDiagnostics } from '../../discord-activity.mjs';
import { join } from 'node:path';

export function createProductionController(ctx, config = {}, internals = {}) {
  const Runtime = class extends DiscordRuntime {
    constructor(options) {
      const diagnostics = createTypingDiagnostics(join(pluginPaths(config, 'discord').bots,
        options.config.botId, 'discord-typing.json'), options.logger);
      super({ ...options, observeActivity: (activity) => {
        if (config.harnessBaseUrl !== undefined) {
          diagnostics({ at: Date.now(), pid: process.pid, attached: false, reason: 'remote-harness',
            busySessions: [], channels: [], lastPulseAtByChannel: {}, errors: [] });
          return null;
        }
        return observeDiscordActivity(ctx, { ...activity, diagnostics });
      } });
    }
  };
  return createTokenProductionController(ctx, config, internals, {
    channel: 'discord',
    ConfigStore: DiscordConfigStore,
    StateStore: DiscordStateStore,
    HarnessClient: DiscordHarnessClient,
    Controller: DiscordController,
    Runtime,
  });
}
