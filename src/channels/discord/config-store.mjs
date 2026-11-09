import {
  deriveTokenBotIdentity,
  maskPlatformId,
  TokenBotConfigStore,
} from '../shared/token-config-store.mjs';
import { t } from '../shared/i18n.mjs';

const IDENTITY_OPTIONS = Object.freeze({
  botPrefix: 'discord',
  tokenRefPrefix: 'DSH_DISCORD_BOT_TOKEN',
});

export function deriveDiscordBotIdentity(platformId) {
  return deriveTokenBotIdentity(platformId, IDENTITY_OPTIONS);
}

export function maskDiscordBotId(platformId) {
  return maskPlatformId(platformId, t('Discord机器人'));
}

export class DiscordConfigStore extends TokenBotConfigStore {
  constructor(path) {
    super(path, {
      channel: 'Discord',
      ...IDENTITY_OPTIONS,
      normalizeBotExtension(value) {
        // duoduo fork: both switches default ON; only an explicit false is stored.
        const switches = {
          ...(value.mentionFree === false ? { mentionFree: false } : {}),
          ...(value.thinkingTraces === false ? { thinkingTraces: false } : {}),
        };
        if (value.ownerUserId == null) return { ownerUserId: null, ...switches };
        const ownerUserId = typeof value.ownerUserId === 'string' ? value.ownerUserId.trim() : '';
        if (!/^\d{5,30}$/.test(ownerUserId) || ownerUserId === value.platformId?.trim()) return null;
        return { ownerUserId, ...switches };
      },
    });
  }

  save(value) {
    // Shared credential binding rebuilds the base config. Preserve only this
    // bot's confirmed identity when omitted; explicit null still clears it.
    const saved = this.get(value?.botId);
    return super.save({
      ...value,
      ownerUserId: value?.ownerUserId === undefined
        ? saved?.ownerUserId ?? null
        : value.ownerUserId,
      mentionFree: value?.mentionFree === undefined ? saved?.mentionFree : value.mentionFree,
      thinkingTraces: value?.thinkingTraces === undefined ? saved?.thinkingTraces : value.thinkingTraces,
    });
  }
}
