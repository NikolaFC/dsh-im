import { captureGroupHistory, groupHistoryEntry } from '../shared/group-history.mjs';
import { extractConnectionEvidence, createConnectionDiagnostics, atConnectionStage } from '../shared/connection-error.mjs';
import { createEditableMessageStream, splitMessageText } from '../shared/editable-message-stream.mjs';
import { chunkMarkdownText } from '../shared/markdown-chunks.mjs';
import { createTextDeliveryBlock } from '../shared/semantic/delivery.mjs';
import { fetchFileStream } from '../shared/file-download.mjs';
import { fetchImageBuffer } from '../shared/image-prompt.mjs';
import { t } from '../shared/i18n.mjs';
import { captureContextEnhancement } from '../shared/context-enhancement.mjs';
import { evaluateInboundAccess } from '../shared/inbound-access.mjs';
import { formatThinkingLine, formatToolTrace } from '../shared/thinking-trace.mjs';
import { registerLiveSegmentBot } from '../shared/session-sync-registry.mjs';
import { DiscordApi } from './discord-api.mjs';
import { discordTypingRetryAfterMs } from './typing-error.mjs';
import { PICKER_COMMANDS, discordCommandChoices, DiscordCommandPickers, boundedDiscordContent } from './discord-command-picker.mjs';
import { discordCardComponents, normalizeDiscordInteraction, syncDiscordCommands } from './discord-interactions.mjs';
import { createDiscordBridgeStatus, DiscordHarnessBridge } from './discord-bridge.mjs';

const DISCORD_GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const THREAD_RECOVERY_TIMEOUT_MS = 5_000;
const TYPING_INTERVAL_MS = 7_500;
const RECONNECT_DELAYS_MS = Object.freeze([1_000, 3_000, 5_000, 10_000, 30_000]);
const GUILD_TEXT = 0;
const GUILD_ANNOUNCEMENT = 5;
const ANNOUNCEMENT_THREAD = 10;
const PUBLIC_THREAD = 11;
const PRIVATE_THREAD = 12;
const THREAD_TYPES = new Set([ANNOUNCEMENT_THREAD, PUBLIC_THREAD, PRIVATE_THREAD]);
const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const IMAGE_FILE_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);
const DISCORD_IMAGE_HOSTS = Object.freeze(['cdn.discordapp.com']);
// duoduo fork: thinking-trace pages. One trace message is edited in place until
// it nears Discord's 2000-character cap; edits are paced under the edit limit.
const TRACE_PAGE_LIMIT = 1_900;
const TRACE_EDIT_INTERVAL_MS = 1_200;

/** Render one trace line as Discord subtext with its markdown neutralized. */
export function discordTraceLine(line) {
  const escaped = String(line).replace(/[\\*_~`|>#[\]()]/g, '\\$&').replace(/^-/, '\\-');
  return `-# ${escaped}`;
}

function socketUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'wss:') throw new Error('Discord returned an insecure Gateway URL');
  url.searchParams.set('v', '10');
  url.searchParams.set('encoding', 'json');
  return url.href;
}

function addSocketListener(socket, event, listener) {
  if (typeof socket.addEventListener === 'function') socket.addEventListener(event, listener);
  else if (typeof socket.on === 'function') socket.on(event, listener);
  else throw new TypeError('Discord WebSocket does not support events');
}

function eventData(event) {
  if (typeof event === 'string') return event;
  if (typeof event?.data === 'string') return event.data;
  if (Buffer.isBuffer(event)) return event.toString('utf8');
  if (Buffer.isBuffer(event?.data)) return event.data.toString('utf8');
  return null;
}

function gatewayCloseError(code) {
  if (code === 4004) {
    const error = new Error(t('Discord Bot Token 无效，请重新填写。'));
    error.code = 'discord-401';
    return error;
  }
  if (code === 4013 || code === 4014) {
    const error = new Error(t('Discord Gateway Intents 配置不正确，请检查 Developer Portal 的 Bot 设置。'));
    error.code = 'discord-intents';
    return error;
  }
  const error = new Error(`Discord Gateway closed (${code || 'unknown'})`);
  error.code = 'discord-gateway-closed';
  return error;
}

function stripBotMention(text, botId) {
  if (typeof text !== 'string') return '';
  return text
    .split(`<@${botId}>`).join('')
    .split(`<@!${botId}>`).join('')
    .trim();
}

function cleanThreadName(message, botId) {
  const name = stripBotMention(message?.content ?? '', botId).replace(/\s+/g, ' ').trim()
    || 'DeepSeek Harness';
  return [...name].slice(0, 100).join('');
}

function isThreadChannel(channel) {
  return THREAD_TYPES.has(Number(channel?.type));
}

function isThreadFromMessage(channel, message) {
  return isThreadChannel(channel)
    && String(channel?.id ?? '') === String(message?.id ?? '')
    && String(channel?.parent_id ?? '') === String(message?.channel_id ?? '');
}

function rememberChannel(channel, callback) {
  if (channel?.id) callback?.(channel);
  return channel;
}

function withConversationRoute(normalized, channel, botId, {
  fromSourceMessage = false,
  fallback = null,
  notice = null,
  mentionFree = false,
} = {}) {
  const channelId = String(channel?.id ?? normalized.conversationId);
  const thread = isThreadChannel(channel);
  const managed = thread && String(channel?.owner_id ?? '') === String(botId);
  const parentId = thread && channel?.parent_id ? String(channel.parent_id) : channelId;
  return {
    ...normalized,
    conversationId: channelId,
    addressed: normalized.addressed || managed,
    requiresMention: mentionFree ? false : thread ? !managed : normalized.kind === 'group',
    replyTarget: {
      channelId,
      ...(!fromSourceMessage && normalized.replyTarget?.replyToMessageId
        ? { replyToMessageId: normalized.replyTarget.replyToMessageId }
        : {}),
      ...(notice ? { notice } : {}),
    },
    connectionTestTarget: { channelId },
    conversationRoute: {
      peerId: parentId,
      ...(thread ? { threadId: channelId, managed } : {}),
      ...(fallback ? { fallback } : {}),
    },
  };
}

function uncertainThreadCreate(error) {
  const status = Number(error?.status);
  return !Number.isInteger(status) || status >= 500;
}

function threadCreateUncertain(cause) {
  const error = new Error('Discord Thread creation result is uncertain', { cause });
  error.code = 'discord-thread-create-uncertain';
  return error;
}

async function findCreatedThread(api, message, { signal, onChannel } = {}) {
  try {
    const channel = rememberChannel(await api.getChannel({
      channelId: String(message.id),
      signal,
    }), onChannel);
    return isThreadFromMessage(channel, message) ? channel : null;
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

async function sendThreadUncertainNotice(api, normalized, signal) {
  try {
    await api.createMessage({
      channelId: normalized.replyTarget.channelId,
      replyToMessageId: normalized.replyTarget.replyToMessageId,
      content: t('Thread 创建结果暂时无法确认。若已创建，请在对应 Thread 中重试；若未创建，请稍后重新 @机器人。'),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
  }
}

function attachmentMediaType(attachment) {
  const value = typeof attachment?.content_type === 'string'
    ? attachment.content_type.split(';', 1)[0].trim().toLowerCase() : '';
  if (IMAGE_MEDIA_TYPES.has(value)) return value;
  const filename = typeof attachment?.filename === 'string' ? attachment.filename.toLowerCase() : '';
  for (const [extension, mediaType] of IMAGE_FILE_TYPES) {
    if (filename.endsWith(extension)) return mediaType;
  }
  return null;
}

function attachmentSize(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function discordImageSource(attachment, fetchImpl) {
  const mediaType = attachmentMediaType(attachment);
  if (!mediaType || typeof attachment?.url !== 'string') return null;
  return {
    name: typeof attachment.filename === 'string' ? attachment.filename : undefined,
    mediaType,
    size: attachmentSize(attachment.size),
    load: (options) => fetchImageBuffer(attachment.url, {
      ...options,
      fetchImpl,
      allowedHosts: DISCORD_IMAGE_HOSTS,
    }),
  };
}

function discordFileSource(attachment, fetchImpl) {
  if (attachmentMediaType(attachment) || typeof attachment?.url !== 'string' || !attachment.url) {
    return null;
  }
  const mediaType = typeof attachment.content_type === 'string' && attachment.content_type
    ? attachment.content_type.split(';', 1)[0].trim().toLowerCase() : undefined;
  return {
    name: typeof attachment.filename === 'string' && attachment.filename
      ? attachment.filename : String(attachment.id ?? 'discord-file'),
    ...(mediaType ? { mediaType } : {}),
    size: attachmentSize(attachment.size),
    load: ({ signal } = {}) => fetchFileStream(attachment.url, {
      fetchImpl,
      signal,
      allowedHosts: DISCORD_IMAGE_HOSTS,
    }),
  };
}

function discordReplyAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') return null;
  const mediaType = typeof attachment.content_type === 'string'
    ? attachment.content_type.split(';', 1)[0].trim().toLowerCase() : '';
  const kind = mediaType.startsWith('image/') ? 'image'
    : mediaType.startsWith('audio/') ? 'audio'
      : mediaType.startsWith('video/') ? 'video' : 'file';
  const name = typeof attachment.filename === 'string' && attachment.filename
    ? attachment.filename : undefined;
  return { kind, ...(name ? { name } : {}) };
}

function discordReplySnapshot(message, fallbackMessageId) {
  if (!message || typeof message !== 'object') return null;
  const messageId = typeof message.id === 'string' && message.id
    ? message.id : fallbackMessageId;
  const authorId = typeof message.author?.id === 'string' && message.author.id
    ? message.author.id : undefined;
  const authorName = [message.member?.nick, message.author?.global_name, message.author?.username]
    .find((value) => typeof value === 'string' && value.trim());
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.map(discordReplyAttachment).filter(Boolean)
    : [];
  if (Array.isArray(message.sticker_items)) {
    attachments.push(...message.sticker_items.map((sticker) => ({
      kind: 'image',
      ...(typeof sticker?.name === 'string' && sticker.name ? { name: sticker.name } : {}),
    })));
  }
  return {
    ...(messageId ? { messageId: String(messageId) } : {}),
    ...(authorId ? { authorId } : {}),
    ...(authorName ? { authorName } : {}),
    content: typeof message.content === 'string' ? message.content : '',
    attachments,
  };
}

function discordReplyReference(message, loadReply) {
  const channelId = String(message?.channel_id ?? '');
  const referenceId = typeof message?.message_reference?.message_id === 'string'
    && message.message_reference.message_id
    ? message.message_reference.message_id : undefined;
  const referenceChannelId = message?.message_reference?.channel_id;
  if (referenceChannelId !== undefined && String(referenceChannelId) !== channelId) {
    return {
      ...(referenceId ? { messageId: referenceId } : {}),
      unavailableReason: 'not-found',
    };
  }
  if (Object.hasOwn(message ?? {}, 'referenced_message')) {
    if (message.referenced_message === null) {
      return {
        ...(referenceId ? { messageId: referenceId } : {}),
        unavailableReason: 'deleted',
      };
    }
    if (message.referenced_message && typeof message.referenced_message === 'object') {
      const snapshotId = typeof message.referenced_message.id === 'string'
        && message.referenced_message.id ? message.referenced_message.id : undefined;
      if (String(message.referenced_message.channel_id ?? '') !== channelId
        || !snapshotId || (referenceId && snapshotId !== referenceId)) {
        return {
          ...(referenceId ? { messageId: referenceId } : {}),
          unavailableReason: 'not-found',
        };
      }
      return discordReplySnapshot(message.referenced_message, referenceId) ?? undefined;
    }
  }
  if (!referenceId) return undefined;
  if (typeof loadReply !== 'function') {
    return { messageId: referenceId, unavailableReason: 'not-delivered' };
  }
  return {
    messageId: referenceId,
    load: async ({ signal } = {}) => {
      const referenced = await loadReply({ channelId, messageId: referenceId, signal });
      if (!referenced || String(referenced.id ?? '') !== referenceId
        || String(referenced.channel_id ?? '') !== channelId) return null;
      return discordReplySnapshot(referenced, referenceId);
    },
  };
}

export function normalizeDiscordMessage(message, botId, {
  fetchImpl = fetch,
  loadReply,
  mentionFree = false,
} = {}) {
  if (!message?.id || !message?.channel_id || !message?.author?.id
    || Number(message.type) === 21) return null;
  const direct = !message.guild_id;
  const addressed = direct || mentionFree
    || message.mentions?.some((mention) => String(mention?.id) === String(botId));
  const replyTo = discordReplyReference(message, loadReply);
  return {
    messageId: String(message.id),
    senderId: String(message.author.id),
    contextSource: () => ({
      senderName: [message.member?.nick, message.author.global_name, message.author.username]
        .find((value) => typeof value === 'string' && value.trim()),
    }),
    senderIsBot: message.author.bot === true,
    kind: direct ? 'direct' : 'group',
    conversationId: String(message.channel_id),
    content: stripBotMention(message.content ?? '', botId),
    plainText: (!Array.isArray(message.attachments) || message.attachments.length === 0)
      && (!Array.isArray(message.sticker_items) || message.sticker_items.length === 0)
      && !message.poll,
    images: Array.isArray(message.attachments)
      ? message.attachments.map((attachment) => discordImageSource(attachment, fetchImpl)).filter(Boolean)
      : [],
    files: Array.isArray(message.attachments)
      ? message.attachments.map((attachment) => discordFileSource(attachment, fetchImpl)).filter(Boolean)
      : [],
    ...(replyTo ? { replyTo } : {}),
    addressed,
    replyTarget: {
      channelId: String(message.channel_id),
      replyToMessageId: String(message.id),
    },
    reactionTarget: {
      channelId: String(message.channel_id),
      messageId: String(message.id),
    },
    connectionTestTarget: { channelId: String(message.channel_id) },
  };
}

export async function resolveDiscordMessageRoute(message, botId, {
  api,
  channel,
  fetchImpl = fetch,
  signal,
  onChannel,
  mentionFree = false,
} = {}) {
  const normalized = normalizeDiscordMessage(message, botId, {
    mentionFree,
    fetchImpl,
    loadReply: typeof api?.getMessage === 'function'
      ? (options) => api.getMessage(options)
      : undefined,
  });
  if (!normalized || normalized.senderIsBot) return normalized;
  signal?.throwIfAborted();
  if (normalized.kind === 'direct') {
    return withConversationRoute(normalized, { id: normalized.conversationId, type: 1 }, botId);
  }
  if (!api || typeof api.getChannel !== 'function') {
    throw new TypeError('Discord route resolution requires the Discord API');
  }

  const sourceChannel = rememberChannel(channel ?? await api.getChannel({
    channelId: normalized.conversationId,
    signal,
  }), onChannel);
  if (isThreadChannel(sourceChannel)) {
    return withConversationRoute(normalized, sourceChannel, botId, { mentionFree });
  }
  // duoduo fork: mention-free bots answer in place instead of opening a Thread.
  if (!normalized.addressed || mentionFree) {
    return withConversationRoute(normalized, sourceChannel, botId, { mentionFree });
  }

  const sourceType = Number(sourceChannel?.type);
  if (sourceType !== GUILD_TEXT && sourceType !== GUILD_ANNOUNCEMENT) {
    return withConversationRoute(normalized, sourceChannel, botId, {
      fallback: 'unsupported-channel',
      notice: '当前频道不支持自动创建 Thread，已直接在当前频道回复。',
    });
  }

  signal?.throwIfAborted();
  let created;
  try {
    created = rememberChannel(await api.startThreadFromMessage({
      channelId: normalized.conversationId,
      messageId: normalized.messageId,
      name: cleanThreadName(message, botId),
      signal,
    }), onChannel);
    if (!isThreadFromMessage(created, message)) {
      throw new Error('Discord returned an invalid thread for the source message');
    }
  } catch (error) {
    let recovered;
    try {
      recovered = await findCreatedThread(api, message, {
        signal: AbortSignal.timeout(THREAD_RECOVERY_TIMEOUT_MS),
        onChannel,
      });
    } catch (recoveryError) {
      if (signal?.aborted) throw signal.reason ?? error;
      await sendThreadUncertainNotice(api, normalized, signal);
      throw threadCreateUncertain(recoveryError);
    }
    if (recovered) {
      return withConversationRoute(normalized, recovered, botId, { fromSourceMessage: true });
    }
    if (signal?.aborted) throw signal.reason ?? error;
    if (uncertainThreadCreate(error)) {
      await sendThreadUncertainNotice(api, normalized, signal);
      throw threadCreateUncertain(error);
    }
    return withConversationRoute(normalized, sourceChannel, botId, {
      fallback: 'thread-create-failed',
      notice: '无法创建 Thread，已直接在当前频道回复。',
    });
  }
  return withConversationRoute(normalized, created, botId, { fromSourceMessage: true });
}

export class DiscordBotClient {
  #api;
  #signal;
  #logger;
  #deliveredNotices = new WeakSet();

  #typing = new Map();
  #now;

  constructor({ api, signal, logger = console, now = Date.now }) {
    this.#now = now;
    this.#api = api;
    this.#signal = signal;
    this.#logger = logger;
  }

  sendText(target, text) {
    return this.#sendText(target, text, false);
  }

  sendDelivery(target, value) {
    const block = createTextDeliveryBlock(value);
    return this.#sendText(target, block.text, block.format === 'markdown');
  }

  async #sendText(target, text, markdown) {
    if (target?.interactionResponse) {
      const handle = target.interactionResponse;
      handle.content = [handle.content, text].filter(Boolean).join('\n\n');
      const result = await this.#api.editOriginalInteraction({ ...handle, content: boundedDiscordContent(handle.content), signal: this.#signal });
      return { providerMessageIds: result?.id ? [result.id] : [] };
    }
    const notice = !this.#deliveredNotices.has(target) && target?.notice
      ? String(target.notice) : null;
    const chunks = (markdown ? chunkMarkdownText : splitMessageText)(notice ? `${notice}\n\n${text}` : text, 1_900);
    const providerMessageIds = [];
    for (const [index, chunk] of chunks.entries()) {
      const result = await this.#api.createMessage({
        channelId: target.channelId,
        content: chunk,
        replyToMessageId: index === 0 ? target.replyToMessageId : undefined,
        signal: this.#signal,
      });
      if (notice && index === 0) this.#deliveredNotices.add(target);
      if (typeof result?.id === 'string' && result.id) providerMessageIds.push(result.id);
    }
    return { providerMessageIds };
  }

  async sendInteractionCard(target, card) {
    if (typeof card?.text !== 'string' || card.text.length > 1900) throw new TypeError('Discord card body is too long');
    const message = await this.#api.createMessage({ channelId: target.channelId,
      content: card.text, components: discordCardComponents(card.markup), signal: this.#signal });
    return { providerMessageIds: [message.id] };
  }

  updateInteractionCard(target, messageId, card) {
    return this.#api.editMessage({ channelId: target.channelId, messageId,
      components: discordCardComponents(card.markup), signal: this.#signal });
  }

  editInteractionCard(target, messageId, card) {
    if (card.text?.length > 2000) throw new TypeError('Discord card body is too long');
    return this.#api.editMessage({ channelId: target.channelId, messageId,
      content: card.text, components: discordCardComponents(card.markup), signal: this.#signal });
  }

  answerInteractionCallback(handle, text) {
    // Gateway dispatch already acknowledged before invoking the shared bridge.
    if (!text) return Promise.resolve();
    return this.#api.followupInteraction({ ...handle, content: text, signal: this.#signal });
  }

  // Both producers remain active. The transport owns the shared rate/in-flight
  // gate, so a broken or unloaded observer can never disable turn typing.
  sendTyping(target) { return this.sendActivityTyping(target); }

  sendActivityTyping(target) {
    const channelId = target.channelId;
    const at = this.#now();
    const previous = this.#typing.get(channelId);
    if (previous && (previous.pending || at - previous.at < TYPING_INTERVAL_MS || at < previous.retryAt)) {
      return Promise.resolve({
        sent: false,
        lastPulseAt: previous.at,
        ...(previous.retryAt > previous.at + TYPING_INTERVAL_MS ? { nextPulseAt: previous.retryAt } : {}),
      });
    }
    for (const [id, row] of this.#typing) {
      if (!row.pending && at - row.at >= TYPING_INTERVAL_MS && at >= row.retryAt) this.#typing.delete(id);
    }
    const row = { at, pending: true, retryAt: -Infinity };
    this.#typing.set(channelId, row);
    const timeout = AbortSignal.timeout(5_000);
    const signal = this.#signal ? AbortSignal.any([this.#signal, timeout]) : timeout;
    return Promise.resolve().then(() => {
      signal.throwIfAborted();
      return this.#api.sendTyping({ channelId, signal });
    }).then(() => ({ sent: true, lastPulseAt: at }), (error) => {
      const delay = discordTypingRetryAfterMs(error);
      if (delay !== undefined) row.retryAt = Math.min(Number.MAX_SAFE_INTEGER, this.#now() + delay);
      throw error;
    }).finally(() => { row.pending = false; });
  }

  sendFile(target, file) {
    return this.#api.createFileMessage({
      channelId: target.channelId,
      file,
      replyToMessageId: target.replyToMessageId,
      signal: this.#signal,
    });
  }

  addReaction(target, emoji, { signal } = {}) {
    return this.#api.addOwnReaction({
      channelId: target.channelId,
      messageId: target.messageId,
      emoji,
      signal: this.#operationSignal(signal),
    });
  }

  removeReaction(target, reactionKey, { signal } = {}) {
    return this.#api.removeOwnReaction({
      channelId: target.channelId,
      messageId: target.messageId,
      emoji: reactionKey,
      signal: this.#operationSignal(signal),
    });
  }

  async openStream(target) {
    const notice = !this.#deliveredNotices.has(target) && target?.notice
      ? String(target.notice) : null;
    const decorate = (content) => notice ? `${notice}\n\n${content}` : content;
    const stream = createEditableMessageStream({
      limit: notice ? 1_800 : 1_900,
      create: async (content) => {
        const message = await this.#api.createMessage({
          channelId: target.channelId,
          content: decorate(content),
          replyToMessageId: target.replyToMessageId,
          signal: this.#signal,
        });
        if (notice) this.#deliveredNotices.add(target);
        return message.id;
      },
      edit: (messageId, content) => this.#api.editMessage({
        channelId: target.channelId,
        messageId,
        content: decorate(content),
        signal: this.#signal,
      }),
      sendRemainder: (content) => this.#api.createMessage({
        channelId: target.channelId,
        content,
        signal: this.#signal,
      }),
      messageIdForResult: (message) => message?.id,
    });
    return stream.start();
  }

  /**
   * duoduo fork: thinking-trace stream. Tool calls and reasoning lines are
   * appended to one trace message that is edited in place (a new page once it
   * fills up), so the channel keeps the think → act chain without a message
   * per step. The answer is then delivered as its own normal message.
   */
  openThinkingStream(target) {
    const client = this;
    const api = this.#api;
    const signal = this.#signal;
    const logger = this.#logger;
    const traceIds = [];
    const segmentIds = [];
    let page = { lines: [], id: null, sent: '' };
    let firstPage = true;
    let chain = Promise.resolve();
    let timer = null;
    let closed = false;
    const clearTimer = () => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    };
    // Every write goes through one chain, so pages and edits land in order and
    // a page's create always precedes its edits.
    const sync = (current) => {
      chain = chain.then(async () => {
        const content = current.lines.join('\n');
        if (!content || content === current.sent) return;
        try {
          if (current.id === null) {
            const message = await api.createMessage({
              channelId: target.channelId,
              content,
              replyToMessageId: current.reply ? target.replyToMessageId : undefined,
              signal,
            });
            if (typeof message?.id === 'string' && message.id) {
              current.id = message.id;
              traceIds.push(message.id);
            }
          } else {
            await api.editMessage({ channelId: target.channelId, messageId: current.id, content, signal });
          }
          current.sent = content;
        } catch (error) {
          logger?.warn?.('[dsh-im:discord] thinking trace delivery failed:', error);
        }
      });
      return chain;
    };
    const append = (line) => {
      if (closed || !line) return Promise.resolve();
      const text = discordTraceLine(line);
      if (page.lines.length > 0 && page.lines.join('\n').length + 1 + text.length > TRACE_PAGE_LIMIT) {
        clearTimer();
        void sync(page);
        page = { lines: [], id: null, sent: '' };
      }
      if (page.lines.length === 0) {
        page.reply = firstPage;
        firstPage = false;
      }
      page.lines.push(text);
      if (page.id === null && page.lines.length === 1) {
        // The first line of a page shows up at once; later lines are paced.
        void sync(page);
      } else if (timer === null) {
        const current = page;
        timer = setTimeout(() => {
          timer = null;
          void sync(current);
        }, TRACE_EDIT_INTERVAL_MS);
        timer.unref?.();
      }
      return Promise.resolve();
    };
    return {
      get messageId() {
        return traceIds[0] ?? null;
      },
      get providerMessageIds() {
        return [...traceIds, ...segmentIds];
      },
      presentation: 'discord-thinking',
      // Long tool runs still want the typing indicator.
      keepalive: true,
      update: async () => {},
      refresh: async () => {},
      sendToolTrace: (name, argumentsValue) => append(formatToolTrace(name, argumentsValue)),
      sendThinking: (text) => append(formatThinkingLine(text)),
      /**
       * Post one finished mid-turn text segment as a normal message, in order
       * with the trace: pending trace lines land first, and later lines open
       * a new trace page below the segment instead of editing one above it.
       */
      sendSegment(answer) {
        if (closed) return Promise.reject(new Error('Message stream is already closed'));
        const raw = answer && typeof answer === 'object' ? answer.text : answer;
        if (typeof raw !== 'string' || !raw.trim()) return Promise.resolve({ providerMessageIds: [] });
        const markdown = Boolean(answer && typeof answer === 'object' && answer.format === 'markdown');
        clearTimer();
        const current = page;
        void sync(current);
        if (current.lines.length > 0) page = { lines: [], id: null, sent: '' };
        // The first message of a turn anchors it to the user's message.
        const segmentTarget = {
          channelId: target.channelId,
          replyToMessageId: firstPage ? target.replyToMessageId : undefined,
        };
        firstPage = false;
        const sent = chain.then(() => client.#sendText(segmentTarget, raw, markdown));
        chain = sent.then((result) => { segmentIds.push(...result.providerMessageIds); }, () => undefined);
        return sent;
      },
      async finish(answer) {
        if (closed) throw new Error('Message stream is already closed');
        closed = true;
        clearTimer();
        await sync(page);
        if (answer && typeof answer === 'object' && answer.liveSegmentsOnly === true && segmentIds.length > 0) {
          return { presentation: 'discord-thinking', providerMessageIds: [] };
        }
        const raw = answer && typeof answer === 'object' ? answer.text : answer;
        const text = typeof raw === 'string' && raw.trim() ? raw : t('处理完成。');
        const markdown = Boolean(answer && typeof answer === 'object' && answer.format === 'markdown');
        const result = await client.#sendText(target, text, markdown);
        return { presentation: 'discord-thinking', providerMessageIds: result.providerMessageIds };
      },
      cancel() {
        closed = true;
        clearTimer();
      },
    };
  }

  #operationSignal(signal) {
    return signal ?? this.#signal;
  }
}

export function createDiscordRuntimeStatus() {
  return {
    startedAt: null,
    ready: false,
    connectionState: 'idle',
    harnessReachable: false,
    lastCheckedAt: null,
    lastConnectedAt: null,
    lastError: null,
    ...createDiscordBridgeStatus(),
  };
}

export class DiscordRuntime {
  #config;
  #token;
  #harness;
  #state;
  #contextEnhancement;
  #groupHistory;
  #accessPolicy;
  #logger;
  #diagnostics;
  #replyTimeoutMs;
  #connectTimeoutMs;
  #createApi;
  #createWebSocket;
  #random;
  #status = createDiscordRuntimeStatus();
  #api = null;
  #bridge = null;
  #abortController = null;
  #socket = null;
  #gatewayUrl = null;
  #resumeUrl = null;
  #sessionId = null;
  #sequence = null;
  #heartbeatTimer = null;
  #heartbeatAcked = true;
  #reconnectTimer = null;
  #reconnectAttempt = 0;
  #generation = 0;
  #stopped = true;
  #starting = null;
  #channels = new Map();
  #routing = new Map();
  #commandPickers = new DiscordCommandPickers();
  #observeActivity;
  #stopActivity = null;
  #stopLiveSegments = null;

  constructor({
    config,
    token,
    harness,
    state,
    contextEnhancement,
    groupHistory,
    accessPolicy,
    logger = console,
    replyTimeoutMs = 600_000,
    connectTimeoutMs = 20_000,
    createApi = (options) => new DiscordApi(options),
    createWebSocket = (url) => new WebSocket(url),
    random = Math.random,
    observeActivity,
  }) {
    if (!config || !token || !harness || !state) {
      throw new TypeError('DiscordRuntime requires config, token, Harness, and state');
    }
    if (typeof createWebSocket !== 'function') throw new TypeError('DiscordRuntime requires WebSocket');
    this.#config = config;
    this.#token = token;
    this.#harness = harness;
    this.#state = state;
    this.#contextEnhancement = contextEnhancement;
    this.#groupHistory = groupHistory;
    this.#accessPolicy = accessPolicy;
    this.#logger = logger; this.#diagnostics = createConnectionDiagnostics({ channel: 'discord', logger });
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#createApi = createApi;
    this.#createWebSocket = createWebSocket;
    this.#random = random;
    this.#observeActivity = observeActivity;
  }

  get status() {
    return structuredClone(this.#status);
  }

  /** duoduo fork: every message addresses the bot unless the config says otherwise. */
  get #mentionFree() {
    return this.#config?.mentionFree !== false;
  }

  async sendConnectionTest(text) {
    if (!this.#status.ready || !this.#bridge) {
      const error = new Error('Discord bot is not connected');
      error.code = 'test-target-unavailable';
      throw error;
    }
    return this.#bridge.sendConnectionTest(text);
  }

  async presentSessionSyncApproval(target, interaction, options = {}) {
    if (!this.#status.ready || !this.#bridge) return false;
    const channelId = target?.route?.channelId;
    const channel = await this.#api.getChannel({ channelId, signal: options.signal });
    const actor = channel?.type === 1 && channel.recipients?.length === 1
      ? channel.recipients[0]?.id : '';
    if (!actor) return false;
    return this.#bridge.presentSessionSyncApproval(interaction, {
      key: options.key, actor, validate: options.validate,
      send: (text) => this.sendProactiveText(target, text),
    }, options);
  }

  async presentSessionSyncQuestion(target, interaction, options = {}) {
    if (!this.#status.ready || !this.#bridge || options.signal?.aborted) return false;
    const channelId = target?.route?.channelId;
    if (target?.kind !== 'channel' || !channelId) return false;
    const channel = await this.#api.getChannel({ channelId, signal: options.signal });
    if (String(channel?.id ?? '') !== channelId) return false;
    const direct = channel.type === 1 && channel.recipients?.length === 1;
    const group = channel.type === GUILD_TEXT || channel.type === GUILD_ANNOUNCEMENT || isThreadChannel(channel);
    if (!direct && !group) return false;
    const kind = direct ? 'direct' : 'group';
    if (options.key !== `${kind}:${channelId}`) return false;
    const actor = direct ? channel.recipients[0]?.id : options.actor;
    const canAnswer = () => Boolean(this.#accessPolicy && actor
      && evaluateInboundAccess(this.#accessPolicy, {
        conversationType: kind, senderIds: [actor], isCommand: false,
      }).allowed);
    if (!canAnswer()) return false;
    return this.#bridge.presentSessionSyncQuestion(interaction, {
      key: options.key,
      actor,
      target: { channelId },
      requiresMention: group && !this.#mentionFree
        && !(isThreadChannel(channel) && String(channel.owner_id) === this.#config.platformId),
      validate: async () => {
        await options.validate?.();
        if (!canAnswer()) throw Object.assign(new Error('Discord question actor is no longer allowed'), {
          code: 'interaction-not-pending',
        });
      },
    }, options);
  }

  async sendProactiveText(target, text, options = {}) {
    if (!this.#status.ready || !this.#bridge) {
      const error = new Error('Discord bot is not connected');
      error.code = 'bot-not-connected';
      throw error;
    }
    const channelId = typeof target?.route?.channelId === 'string'
      ? target.route.channelId.trim() : '';
    if (target?.kind !== 'channel' || !channelId) {
      const error = new TypeError('Invalid Discord proactive delivery target');
      error.code = 'invalid-target';
      throw error;
    }
    return this.#bridge.sendProactiveText({ channelId }, text, options);
  }

  async start() {
    if (this.#status.ready && this.#socket) return this.status;
    if (this.#starting) return this.#starting;
    this.#starting = this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #start() {
    await this.stop();
    this.#stopped = false;
    this.#sessionId = null;
    this.#resumeUrl = null;
    this.#sequence = null;
    this.#reconnectAttempt = 0;
    this.#channels.clear();
    this.#routing.clear();
    this.#status.startedAt = new Date().toISOString();
    this.#status.connectionState = 'connecting';
    this.#status.lastError = null; this.#status.error = null; this.#diagnostics.clear();
    await atConnectionStage('harness.check', () => this.#harness.ensureRunning());
    this.#status.harnessReachable = true;
    const controller = new AbortController();
    this.#abortController = controller;
    const api = this.#createApi({ token: this.#token });
    this.#api = api;
    try {
      const [bot, gateway] = await Promise.all([
        api.getCurrentUser({ signal: controller.signal }),
        api.getGatewayBot({ signal: controller.signal }),
      ]);
      if (String(bot?.id ?? '') !== this.#config.platformId || bot?.bot !== true) {
        throw new Error('Discord token identity does not match the saved bot');
      }
      this.#gatewayUrl = gateway?.url;
      const client = new DiscordBotClient({ api, signal: controller.signal, logger: this.#logger });
      this.#bridge = new DiscordHarnessBridge({
        bot: client,
        harness: this.#harness,
        state: this.#state,
        contextEnhancement: this.#contextEnhancement,
        accessPolicy: this.#accessPolicy,
        status: this.#status,
        logger: this.#logger,
        replyTimeoutMs: this.#replyTimeoutMs,
        // duoduo fork: default ON; an explicit false in the bot config opts out.
        thinkingTraces: this.#config?.thinkingTraces !== false,
        // duoduo fork: mid-turn text goes out per step; same opt-out rule.
        liveText: this.#config?.liveText !== false,
        signal: controller.signal,
      });
      // Goal rounds reach this bot through Session sync; opt them in as well.
      if (this.#config?.liveText !== false && this.#config?.botId) {
        this.#stopLiveSegments = registerLiveSegmentBot({ channel: 'discord', botId: this.#config.botId });
      }
      let timer;
      try {
        await Promise.race([
          this.#openSocket(false),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error('Discord Gateway did not become ready in time'), { code: 'ETIMEDOUT', timeoutMs: this.#connectTimeoutMs })), this.#connectTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (this.#observeActivity) {
        try {
          this.#stopActivity = this.#observeActivity({
            state: this.#state,
            sendTyping: (target) => this.#status.ready
              ? client.sendActivityTyping(target) : Promise.resolve(),
            signal: controller.signal,
            logger: this.#logger,
          });
        } catch {
          this.#logger.warn?.('[dsh-im:discord] activity lifecycle unavailable; retaining turn typing');
        }
      }
      // A missing command permission must not take the connected chat offline.
      if (typeof api.listApplicationCommands === 'function') {
        try {
          this.#status.nativeCommands = await syncDiscordCommands(api, this.#config.platformId, controller.signal);
        } catch (error) {
          this.#logger.warn?.('[dsh-im:discord] native command registration failed:', error?.code ?? 'unavailable');
          this.#status.nativeCommands = { error: error?.code ?? 'unavailable' };
        }
      }
      return this.status;
    } catch (error) {
      this.#status.ready = false;
      this.#status.connectionState = 'failed';
      this.#status.error = this.#diagnostics.report(error, { operation: 'connection.restore', reuse: true, botId: this.#config?.botId, automatic: true }).publicError;
      this.#status.lastError = this.#status.error.message;
      await this.stop();
      throw error;
    }
  }

  #openSocket(resume) {
    if (this.#stopped) return Promise.reject(new Error('Discord runtime is stopped'));
    const generation = ++this.#generation;
    const url = socketUrl(resume && this.#resumeUrl ? this.#resumeUrl : this.#gatewayUrl);
    const socket = this.#createWebSocket(url);
    this.#socket = socket;
    let settled = false;
    return new Promise((resolve, reject) => {
      const markReady = () => {
        if (settled || generation !== this.#generation) return;
        settled = true;
        this.#reconnectAttempt = 0;
        const now = Date.now();
        this.#status.ready = true;
        this.#status.connectionState = 'connected';
        this.#status.lastCheckedAt = now;
        this.#status.lastConnectedAt = now;
        this.#status.lastError = null; this.#status.error = null; this.#diagnostics.clear();
        resolve();
      };
      addSocketListener(socket, 'message', (event) => {
        if (generation !== this.#generation || this.#stopped) return;
        const raw = eventData(event);
        if (!raw) return;
        let packet;
        try {
          packet = JSON.parse(raw);
        } catch {
          this.#logger.warn?.('[dsh-im:discord] ignored malformed Gateway JSON');
          return;
        }
        if (Number.isSafeInteger(packet.s)) this.#sequence = packet.s;
        if (packet.op === 10) {
          this.#startHeartbeat(packet.d?.heartbeat_interval, socket, generation);
          if (resume && this.#sessionId) {
            this.#sendGateway(socket, {
              op: 6,
              d: { token: this.#token, session_id: this.#sessionId, seq: this.#sequence },
            });
          } else {
            this.#sendGateway(socket, {
              op: 2,
              d: {
                token: this.#token,
                intents: DISCORD_GATEWAY_INTENTS,
                properties: {
                  os: process.platform,
                  browser: 'dsh-im',
                  device: 'dsh-im',
                },
              },
            });
          }
          return;
        }
        if (packet.op === 11) {
          this.#heartbeatAcked = true;
          this.#status.lastCheckedAt = Date.now();
          return;
        }
        if (packet.op === 1) {
          this.#heartbeat(socket);
          return;
        }
        if (packet.op === 7) {
          socket.close(4000, 'Reconnect requested');
          return;
        }
        if (packet.op === 9) {
          if (packet.d !== true) {
            this.#sessionId = null;
            this.#resumeUrl = null;
            this.#sequence = null;
          }
          socket.close(4000, 'Invalid session');
          return;
        }
        if (packet.op !== 0) return;
        if (packet.t === 'READY') {
          this.#sessionId = packet.d?.session_id ?? null;
          this.#resumeUrl = packet.d?.resume_gateway_url ?? null;
          markReady();
        } else if (packet.t === 'RESUMED') {
          markReady();
        } else if (packet.t === 'GUILD_CREATE') {
          for (const channel of [...(packet.d?.channels ?? []), ...(packet.d?.threads ?? [])]) {
            this.#rememberChannel(channel);
          }
        } else if (packet.t === 'CHANNEL_CREATE' || packet.t === 'CHANNEL_UPDATE'
          || packet.t === 'THREAD_CREATE' || packet.t === 'THREAD_UPDATE') {
          this.#rememberChannel(packet.d);
        } else if (packet.t === 'CHANNEL_DELETE' || packet.t === 'THREAD_DELETE') {
          if (packet.d?.id) this.#channels.delete(String(packet.d.id));
        } else if (packet.t === 'THREAD_LIST_SYNC') {
          for (const channel of packet.d?.threads ?? []) this.#rememberChannel(channel);
        } else if (packet.t === 'INTERACTION_CREATE') {
          void this.#acceptInteraction(packet.d).catch((error) => {
            // Never log interaction payloads or webhook-token URLs.
            this.#logger.warn?.('[dsh-im:discord] interaction failed:', error?.code ?? 'unavailable');
          });
        } else if (packet.t === 'MESSAGE_CREATE') {
          const bridge = this.#bridge;
          if (packet.d && bridge) {
            void this.#acceptMessage(packet.d, bridge).catch((error) => {
              if (generation !== this.#generation || this.#stopped) return;
              this.#logger.error?.(
                `[dsh-im:discord] bot ${this.#config.botId} message handling failed:`,
                extractConnectionEvidence(error).details,
              );
            });
          }
        }
      });
      addSocketListener(socket, 'close', (event = {}) => {
        if (generation !== this.#generation) return;
        this.#clearHeartbeat();
        if (this.#socket === socket) this.#socket = null;
        if (this.#stopped) {
          if (!settled) reject(new DOMException('Stopped', 'AbortError'));
          return;
        }
        const error = gatewayCloseError(Number(event.code) || 0);
        this.#status.ready = false;
        this.#status.connectionState = 'connecting';
        this.#status.error = this.#diagnostics.report(error, { operation: 'connection.monitor', botId: this.#config?.botId, automatic: true }).publicError;
        this.#status.lastError = this.#status.error.message;
        if (!settled) {
          settled = true;
          reject(error);
        }
        if (error.code === 'discord-401' || error.code === 'discord-intents') {
          this.#status.connectionState = 'failed';
          return;
        }
        this.#scheduleReconnect();
      });
      addSocketListener(socket, 'error', (event) => {
        const error = event?.error ?? new Error('WebSocket error');
        if (generation !== this.#generation || this.#stopped) return;
        this.#status.error = this.#diagnostics.report(error, { operation: 'connection.monitor', botId: this.#config?.botId, automatic: true }).publicError;
        this.#status.lastError = this.#status.error.message;
      });
    });
  }

  async #acceptInteraction(interaction) {
    const normalized = normalizeDiscordInteraction(interaction, this.#config.platformId);
    const api = this.#api;
    const bridge = this.#bridge;
    if (!normalized || !api || !bridge) return;
    let commandName = interaction.data?.name;
    const buttonPress = interaction.type === 3 && normalized.data?.startsWith('dbtn|');
    const pickerPress = interaction.type === 3 && (normalized.data?.startsWith('dc1|') || buttonPress);
    const wantsHelp = interaction.type === 2 && commandName === 'help';
    let wantsPicker = interaction.type === 2 && (PICKER_COMMANDS.has(commandName) || commandName === 'steer')
      && normalized.content === `/${commandName}`;
    if (wantsPicker || pickerPress || wantsHelp) {
      const signal = this.#abortController?.signal;
      await api.respondInteraction({ interactionId: interaction.id, token: interaction.token,
        type: pickerPress ? 6 : 5, ...(pickerPress ? {} : { data: { flags: 64 } }), signal });
      const handle = { applicationId: this.#config.platformId, token: interaction.token };
      normalized.replyTarget.interactionResponse = handle;
      const key = `${normalized.kind}:${normalized.conversationId}`;
      if (pickerPress) {
        // An unauthorized press must not retire the owner's still-live picker.
        if (!this.#commandPickers.belongsTo(normalized)) return;
        const command = this.#commandPickers.claim(normalized, this.#state.sessionFor(key));
        if (!command) {
          await api.editOriginalInteraction({ ...handle, content: '此选项已失效或不属于你，请重新执行命令。', signal });
          return;
        }
        normalized.content = command;
        if (buttonPress) {
          commandName = command.slice(1);
          wantsPicker = PICKER_COMMANDS.has(commandName) || commandName === 'steer';
        }
      }
      // Use the same access gate before reading catalogs, and again in accept
      // after selection. A visible picker never grants command permission.
      const access = this.#accessPolicy ? evaluateInboundAccess(this.#accessPolicy, {
        conversationType: normalized.kind, senderIds: [normalized.senderId], text: normalized.content,
        hasImages: false, hasFiles: false,
      }) : null;
      if (access && !access.allowed) {
        await api.editOriginalInteraction({ ...handle, content: '当前用户无权执行此命令。', signal });
        await bridge.accept(normalized, { accessDecision: access });
        return;
      }
      if (wantsHelp) {
        try {
          const panel = this.#commandPickers.issueHelp(normalized, this.#state.sessionFor(key));
          await api.editOriginalInteraction({ ...handle, ...panel, signal });
          return;
        } catch {
          // Preserve the ordinary text help through the same response target.
          handle.content = '按钮面板暂不可用，显示文字帮助。';
        }
      }
      if (wantsPicker) {
        let reason = '当前没有可选项，显示文字命令结果。';
        if (commandName === 'steer') reason = '纠偏需要输入具体内容；请使用 /steer input:补充指令。普通消息也可按当前设置插话。';
        else {
          try {
            const pickerSessionId = this.#state.sessionFor(key);
            const choices = await discordCommandChoices(commandName, this.#harness, this.#state, key,
              signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000));
            if (this.#state.sessionFor(key) !== pickerSessionId) throw new Error('Session binding changed');
            const card = this.#commandPickers.issue(normalized, choices.choices ?? choices, pickerSessionId, choices.content);
            if (card) { await api.editOriginalInteraction({ ...handle, ...card, signal }); return; }
          } catch { reason = '暂时无法读取选项，显示文字命令结果。'; }
        }
        handle.content = reason;
        await api.editOriginalInteraction({ ...handle, content: reason, signal });
      }
      return bridge.accept(normalized);
    }
    // ACK is the first I/O, before route lookup, access checks or Host work.
    await api.respondInteraction({ interactionId: interaction.id, token: interaction.token,
      type: interaction.type === 3 ? 6 : 4,
      ...(interaction.type === 2 ? { data: { content: t('已收到操作，请查看下方结果。'), flags: 64 } } : {}),
      signal: this.#abortController?.signal });
    if (interaction.type === 3) return bridge.acceptCallback(normalized);
    // Slash commands use the exact channel/thread binding and access policy of
    // text commands, without creating a thread or pretending to be a message.
    return bridge.accept(normalized);
  }

  #rememberChannel(channel) {
    if (!channel?.id) return;
    this.#channels.set(String(channel.id), channel);
  }

  async #acceptMessage(message, bridge) {
    const messageId = String(message?.id ?? '');
    if (!messageId || this.#state.hasSeen(messageId)) return;
    const preflight = normalizeDiscordMessage(message, this.#config.platformId, {
      mentionFree: this.#mentionFree,
    });
    if (preflight) await captureGroupHistory(this.#groupHistory, preflight, groupHistoryEntry('discord', message, preflight, {
      groupName: this.#channels.get(String(message.channel_id))?.name,
    }), { logger: this.#logger });
    let accessDecision;
    if (preflight?.kind === 'group' && preflight.addressed === true
      && preflight.senderIsBot !== true) {
      accessDecision = evaluateInboundAccess(this.#accessPolicy, {
        conversationType: 'group',
        senderIds: [preflight.senderId],
        text: preflight.content,
        hasImages: preflight.images.length > 0,
        hasFiles: preflight.files.length > 0,
      });
      if (!accessDecision.allowed) {
        // Let the shared bridge apply its normal silent/command-denial behavior,
        // but do so against the source channel before creating a Thread.
        await bridge.accept(preflight, { accessDecision });
        return;
      }
    }
    let route = this.#routing.get(messageId);
    if (!route) {
      const contextSnapshot = captureContextEnhancement(
        this.#contextEnhancement,
        message.guild_id ? 'group' : 'direct',
      );
      const busyMessageMode = this.#harness.currentBusyMessageMode?.() ?? 'queue';
      const pendingRoute = resolveDiscordMessageRoute(message, this.#config.platformId, {
        api: this.#api,
        channel: this.#channels.get(String(message.channel_id)),
        signal: this.#abortController?.signal,
        onChannel: (resolved) => this.#rememberChannel(resolved),
        mentionFree: this.#mentionFree,
      });
      route = { pendingRoute, contextSnapshot, busyMessageMode };
      this.#routing.set(messageId, route);
      void pendingRoute.finally(() => {
        if (this.#routing.get(messageId) === route) this.#routing.delete(messageId);
      }).catch(() => undefined);
    }
    try {
      const normalized = await route.pendingRoute;
      if (normalized) {
        normalized.groupHistory = preflight?.groupHistory;
        await bridge.accept(normalized, {
          contextSnapshot: route.contextSnapshot,
          busyMessageMode: route.busyMessageMode,
          ...(accessDecision ? { accessDecision } : {}),
        });
      }
    } catch (error) {
      if (error?.code === 'discord-thread-create-uncertain') {
        await this.#state.markSeen(messageId);
      }
      throw error;
    }
  }

  #sendGateway(socket, payload) {
    if (socket.readyState !== 1) return;
    socket.send(JSON.stringify(payload));
  }

  #startHeartbeat(interval, socket, generation) {
    this.#clearHeartbeat();
    if (!Number.isFinite(interval) || interval < 1_000) {
      socket.close(4000, 'Invalid heartbeat interval');
      return;
    }
    this.#heartbeatAcked = true;
    const schedule = (delay) => {
      this.#heartbeatTimer = setTimeout(() => {
        if (this.#stopped || generation !== this.#generation || this.#socket !== socket) return;
        if (!this.#heartbeatAcked) {
          socket.close(4000, 'Heartbeat was not acknowledged');
          return;
        }
        this.#heartbeat(socket);
        schedule(interval);
      }, delay);
      this.#heartbeatTimer?.unref?.();
    };
    schedule(Math.floor(interval * this.#random()));
  }

  #heartbeat(socket) {
    this.#heartbeatAcked = false;
    this.#sendGateway(socket, { op: 1, d: this.#sequence });
  }

  #clearHeartbeat() {
    if (this.#heartbeatTimer !== null) clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
    this.#heartbeatAcked = true;
  }

  #scheduleReconnect() {
    if (this.#stopped || this.#reconnectTimer !== null) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.#reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#openSocket(Boolean(this.#sessionId)).catch((error) => {
        if (this.#stopped) return;
        this.#logger.warn?.('[dsh-im:discord] Gateway reconnect failed:', extractConnectionEvidence(error).details);
        this.#scheduleReconnect();
      });
    }, delay);
    this.#reconnectTimer?.unref?.();
  }

  async stop() {
    this.#stopped = true;
    this.#stopActivity?.();
    this.#stopActivity = null;
    this.#stopLiveSegments?.();
    this.#stopLiveSegments = null;
    this.#generation += 1;
    this.#abortController?.abort();
    this.#abortController = null;
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#clearHeartbeat();
    const socket = this.#socket;
    const bridge = this.#bridge;
    this.#socket = null;
    this.#bridge = null;
    this.#api = null;
    this.#routing.clear();
    try {
      if (socket && socket.readyState < 2) socket.close(1000, 'Plugin stopped');
    } catch (error) {
      this.#logger.warn?.(`[dsh-im:discord] bot ${this.#config.botId} failed to close Gateway:`, extractConnectionEvidence(error).details);
    }
    await Promise.race([
      bridge?.waitForIdle() ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    this.#status.ready = false;
    this.#status.connectionState = 'idle';
    return this.status;
  }
}
