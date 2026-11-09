import { DISCORD_INTERACTION_CARD, DiscordApprovalCard } from './discord-interactions.mjs';
import { TextHarnessBridge, createTextBridgeStatus } from '../shared/text-harness-bridge.mjs';

export const DISCORD_DESCRIPTOR = Object.freeze({
  key: 'discord',
  label: 'Discord',
  connectionLabel: ' Gateway 长连接',
  reactions: Object.freeze({ processing: '👀', success: '✅', error: '❌' }),
});

export class DiscordHarnessBridge extends TextHarnessBridge {
  constructor(options) {
    super({ descriptor: DISCORD_DESCRIPTOR, interactionCard: DISCORD_INTERACTION_CARD,
      approvalCard: new DiscordApprovalCard({ logger: options?.logger }), ...options });
  }
}

export { createTextBridgeStatus as createDiscordBridgeStatus };
