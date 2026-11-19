import { createHash } from 'node:crypto';
import { t } from '../shared/i18n.mjs';

const DEFAULT_BASE_URL = 'https://discord.com/api/v10/';
const DEFAULT_FILE_UPLOAD_TIMEOUT_MS = 120_000;
const DISCORD_PERMISSION_ERRORS = new Set([50001, 50013]);
const DISCORD_TOO_LARGE_ERRORS = new Set([40005]);

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function positiveTimeout(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function preserveProviderMetadata(target, source) {
  if (source?.providerCode !== undefined) target.providerCode = source.providerCode;
  if (source?.retry_after !== undefined) {
    target.retry_after = source.retry_after;
    target.retryAfter = source.retry_after;
  }
  if (Number.isInteger(source?.status)) target.status = source.status;
  return target;
}

function discordArtifactProviderError(cause) {
  const providerCode = Number(cause?.providerCode);
  const status = Number(cause?.status);
  const message = cleanString(cause?.message) ?? '';
  let code = 'artifact-provider-rejected';
  let summary = 'Discord rejected the attachment.';
  if (status === 401 || status === 403 || DISCORD_PERMISSION_ERRORS.has(providerCode)) {
    code = 'artifact-permission-required';
    summary = 'Discord denied permission to send the attachment.';
  } else if (status === 413 || DISCORD_TOO_LARGE_ERRORS.has(providerCode)
    || /(?:request|attachment|file).{0,24}too large/i.test(message)) {
    code = 'artifact-too-large';
    summary = 'The attachment exceeds Discord\'s size limit.';
  } else if (status === 429) {
    code = 'artifact-rate-limited';
    summary = 'Discord rate-limited attachment delivery.';
  } else if (status >= 500) {
    code = 'artifact-delivery-uncertain';
    summary = 'Discord attachment delivery result is uncertain.';
  }
  const error = new Error(summary, { cause });
  error.code = code;
  return preserveProviderMetadata(error, cause);
}

function uncertainDiscordDelivery(cause) {
  const error = new Error('Discord attachment delivery result is uncertain', { cause });
  error.code = 'artifact-delivery-uncertain';
  return preserveProviderMetadata(error, cause);
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    timer?.unref?.();
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function snowflake(value, name) {
  const id = cleanString(value);
  if (!id || !/^\d{5,30}$/.test(id)) throw new TypeError(`Invalid Discord ${name}`);
  return id;
}

function applicationCommandPath({ applicationId, guildId, commandId }) {
  const guildPath = guildId === undefined ? '' : `/guilds/${snowflake(guildId, 'guild id')}`;
  const commandPath = commandId === undefined ? '' : `/${snowflake(commandId, 'command id')}`;
  return `applications/${snowflake(applicationId, 'application id')}${guildPath}/commands${commandPath}`;
}

function threadName(value) {
  const name = cleanString(value);
  if (!name || [...name].length > 100) {
    throw new TypeError('Discord thread name must contain 1-100 characters');
  }
  return name;
}

function threadOptions({ autoArchiveDuration, rateLimitPerUser } = {}) {
  const body = {};
  if (autoArchiveDuration !== undefined) {
    if (![60, 1440, 4320, 10080].includes(autoArchiveDuration)) {
      throw new TypeError('Invalid Discord thread auto archive duration');
    }
    body.auto_archive_duration = autoArchiveDuration;
  }
  if (rateLimitPerUser !== undefined) {
    if (!Number.isInteger(rateLimitPerUser) || rateLimitPerUser < 0 || rateLimitPerUser > 21600) {
      throw new TypeError('Discord thread rate limit must be an integer from 0 to 21600');
    }
    body.rate_limit_per_user = rateLimitPerUser;
  }
  return body;
}

function boundedInteger(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`Invalid Discord ${label}`);
  return value;
}

function booleanValue(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`Invalid Discord ${label}`);
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError('Discord cursor must be an ISO timestamp with timezone');
  }
  return value;
}

function querySuffix(values) {
  const query = new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined));
  return query.size ? `?${query}` : '';
}

function appliedTagIds(value) {
  if (!Array.isArray(value) || value.length > 5) throw new TypeError('Discord thread supports at most 5 tags');
  const ids = value.map(id => snowflake(id, 'tag id'));
  if (new Set(ids).size !== ids.length) throw new TypeError('Discord thread tags must be unique');
  return ids;
}

function availableForumTags(value) {
  if (!Array.isArray(value) || value.length > 20) throw new TypeError('Discord forum supports at most 20 tags');
  return value.map(tag => {
    if (!tag || typeof tag !== 'object' || Array.isArray(tag)
      || Object.keys(tag).some(key => !['id', 'name', 'moderated', 'emojiId', 'emojiName'].includes(key))
      || typeof tag.name !== 'string' || [...tag.name].length > 20) throw new TypeError('Invalid Discord forum tag');
    const result = { name: tag.name };
    if (tag.id !== undefined) result.id = snowflake(tag.id, 'tag id');
    if (tag.moderated !== undefined) result.moderated = booleanValue(tag.moderated, 'tag moderated');
    if (tag.emojiId != null && tag.emojiName != null) throw new TypeError('Specify at most one tag emoji');
    if (tag.emojiId !== undefined) result.emoji_id = tag.emojiId === null ? null : snowflake(tag.emojiId, 'emoji id');
    if (tag.emojiName !== undefined) {
      if (tag.emojiName !== null && (typeof tag.emojiName !== 'string' || !tag.emojiName || tag.emojiName.length > 100)) throw new TypeError('Invalid tag emoji name');
      result.emoji_name = tag.emojiName;
    }
    return result;
  });
}

function channelOptions({ name, topic, parentId, position, rateLimitPerUser, availableTags }, topicLimit = 4096) {
  const body = threadOptions({ rateLimitPerUser });
  if (name !== undefined) body.name = threadName(name);
  if (topic !== undefined) {
    if (topic !== null && (typeof topic !== 'string' || [...topic].length > topicLimit)) throw new TypeError('Invalid Discord channel topic');
    body.topic = topic;
  }
  if (parentId !== undefined) body.parent_id = parentId === null ? null : snowflake(parentId, 'parent id');
  if (position !== undefined) body.position = boundedInteger(position, 0, 2147483647, 'channel position');
  if (availableTags !== undefined) body.available_tags = availableForumTags(availableTags);
  return body;
}

function reactionEmoji(value) {
  const emoji = cleanString(value);
  if (!emoji) throw new TypeError('A Discord reaction emoji is required');
  return emoji;
}

export function validDiscordToken(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/.test(value.trim());
}

export class DiscordApi {
  #token;
  #fetch;
  #baseUrl;
  #fileUploadTimeoutMs;

  constructor({
    token,
    fetchImpl = fetch,
    baseUrl = DEFAULT_BASE_URL,
    fileUploadTimeoutMs = DEFAULT_FILE_UPLOAD_TIMEOUT_MS,
  }) {
    if (!validDiscordToken(token)) throw new TypeError('Discord Bot Token is invalid');
    if (typeof fetchImpl !== 'function') throw new TypeError('DiscordApi requires fetch');
    this.#token = token.trim();
    this.#fetch = fetchImpl;
    this.#baseUrl = new URL(baseUrl);
    this.#fileUploadTimeoutMs = positiveTimeout(fileUploadTimeoutMs, 'fileUploadTimeoutMs');
  }

  getCurrentUser(options = {}) {
    return this.#request('users/@me', { ...options, method: 'GET' });
  }

  getCurrentApplication(options = {}) {
    return this.#request('applications/@me', { ...options, method: 'GET' });
  }

  listApplicationCommands({ applicationId, guildId, signal }) {
    return this.#request(applicationCommandPath({ applicationId, guildId }), { method: 'GET', signal });
  }

  createApplicationCommand({ applicationId, guildId, command, signal }) {
    return this.#request(applicationCommandPath({ applicationId, guildId }), { method: 'POST', body: command, signal });
  }

  editApplicationCommand({ applicationId, guildId, commandId, command, signal }) {
    return this.#request(applicationCommandPath({ applicationId, guildId, commandId }), { method: 'PATCH', body: command, signal });
  }

  respondInteraction({ interactionId, token, type, data, signal }) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9._-]+$/.test(token)) throw new TypeError('Invalid interaction token');
    return this.#request(`interactions/${snowflake(interactionId, 'interaction id')}/${token}/callback`, {
      // A modal (type 9) carries no message, so it takes no mention policy.
      method: 'POST', body: { type, ...(data ? { data: type === 9 ? data : { ...data, allowed_mentions: { parse: [], replied_user: false } } } : {}) },
      signal, timeoutMs: 2500, expectBody: false, retry: false,
    });
  }

  editOriginalInteraction({ applicationId, token, content, components = [], signal }) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9._-]+$/.test(token)) throw new TypeError('Invalid interaction token');
    return this.#request(`webhooks/${snowflake(applicationId, 'application id')}/${token}/messages/@original`, {
      method: 'PATCH', body: { content, components, allowed_mentions: { parse: [], replied_user: false } }, signal, timeoutMs: 10000,
    });
  }

  followupInteraction({ applicationId, token, content, signal }) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9._-]+$/.test(token)) throw new TypeError('Invalid interaction token');
    return this.#request(`webhooks/${snowflake(applicationId, 'application id')}/${token}`, {
      method: 'POST', body: { content, flags: 64, allowed_mentions: { parse: [], replied_user: false } }, signal, retry: false,
    });
  }

  getGatewayBot(options = {}) {
    return this.#request('gateway/bot', { ...options, method: 'GET' });
  }

  getChannel({ channelId, signal } = {}) {
    return this.#request(`channels/${snowflake(channelId, 'channel id')}`, {
      method: 'GET',
      signal,
    });
  }

  listGuildChannels({ guildId, signal } = {}) {
    return this.#request(`guilds/${snowflake(guildId, 'guild id')}/channels`, { method: 'GET', signal });
  }

  createGuildChannel({ guildId, type = 0, auditReason, signal, ...fields } = {}) {
    if (![0, 2, 4, 15].includes(type)) throw new TypeError('Supported channel types are text, voice, category and forum');
    const body = { ...channelOptions(fields, type === 15 ? 4096 : 1024), name: threadName(fields.name), type };
    if (type !== 15 && fields.availableTags !== undefined) throw new TypeError('Forum tags require a forum channel');
    return this.#request(`guilds/${snowflake(guildId, 'guild id')}/channels`, { method: 'POST', body, auditReason, signal });
  }

  updateChannel({ channelId, auditReason, signal, ...fields } = {}) {
    const body = channelOptions(fields);
    if (!Object.keys(body).length) throw new TypeError('Channel update requires at least one field');
    return this.#request(`channels/${snowflake(channelId, 'channel id')}`, { method: 'PATCH', body, auditReason, signal });
  }

  deleteChannel({ channelId, auditReason, signal } = {}) {
    return this.#request(`channels/${snowflake(channelId, 'channel id')}`, { method: 'DELETE', auditReason, signal });
  }

  moveChannel({ guildId, channelId, position, parentId, lockPermissions, auditReason, signal } = {}) {
    const body = { id: snowflake(channelId, 'channel id') };
    if (position !== undefined) body.position = boundedInteger(position, 0, 2147483647, 'channel position');
    if (parentId !== undefined) body.parent_id = parentId === null ? null : snowflake(parentId, 'parent id');
    if (lockPermissions !== undefined) {
      if (parentId === undefined) throw new TypeError('lockPermissions requires parentId');
      body.lock_permissions = booleanValue(lockPermissions, 'lock permissions');
    }
    if (Object.keys(body).length === 1) throw new TypeError('Channel move requires position or parentId');
    return this.#request(`guilds/${snowflake(guildId, 'guild id')}/channels`, { method: 'PATCH', body: [body], expectBody: false, auditReason, signal });
  }

  listMessages({ channelId, before, after, around, limit, signal } = {}) {
    if ([before, after, around].filter(value => value !== undefined).length > 1) throw new TypeError('Message cursors are mutually exclusive');
    const query = {};
    for (const [key, value] of Object.entries({ before, after, around })) if (value !== undefined) query[key] = snowflake(value, 'message cursor');
    if (limit !== undefined) query.limit = boundedInteger(limit, 1, 100, 'message limit');
    return this.#request(`channels/${snowflake(channelId, 'channel id')}/messages${querySuffix(query)}`, { method: 'GET', signal });
  }

  deleteMessage({ channelId, messageId, signal } = {}) {
    return this.#request(`channels/${snowflake(channelId, 'channel id')}/messages/${snowflake(messageId, 'message id')}`, { method: 'DELETE', expectBody: false, signal });
  }

  listPins({ channelId, before, limit, signal } = {}) {
    const query = {};
    if (before !== undefined) query.before = timestamp(before);
    if (limit !== undefined) query.limit = boundedInteger(limit, 1, 50, 'pins limit');
    return this.#request(`channels/${snowflake(channelId, 'channel id')}/messages/pins${querySuffix(query)}`, { method: 'GET', signal });
  }

  pinMessage({ channelId, messageId, auditReason, signal } = {}) {
    return this.#request(`channels/${snowflake(channelId, 'channel id')}/messages/pins/${snowflake(messageId, 'message id')}`, { method: 'PUT', expectBody: false, auditReason, signal });
  }

  unpinMessage({ channelId, messageId, auditReason, signal } = {}) {
    return this.#request(`channels/${snowflake(channelId, 'channel id')}/messages/pins/${snowflake(messageId, 'message id')}`, { method: 'DELETE', expectBody: false, auditReason, signal });
  }

  listThreadMembers({ threadId, after, limit, withMember = true, signal } = {}) {
    const query = { with_member: booleanValue(withMember, 'withMember') };
    if (after !== undefined) query.after = snowflake(after, 'member cursor');
    if (limit !== undefined) query.limit = boundedInteger(limit, 1, 100, 'member limit');
    if (!withMember && (after !== undefined || limit !== undefined)) throw new TypeError('Thread member pagination requires withMember=true');
    return this.#request(`channels/${snowflake(threadId, 'thread id')}/thread-members${querySuffix(query)}`, { method: 'GET', signal });
  }

  addThreadMember({ threadId, userId, signal } = {}) {
    return this.#request(`channels/${snowflake(threadId, 'thread id')}/thread-members/${snowflake(userId, 'user id')}`, { method: 'PUT', expectBody: false, signal });
  }

  removeThreadMember({ threadId, userId, signal } = {}) {
    return this.#request(`channels/${snowflake(threadId, 'thread id')}/thread-members/${snowflake(userId, 'user id')}`, { method: 'DELETE', expectBody: false, signal });
  }

  joinThread({ threadId, signal } = {}) {
    return this.#request(`channels/${snowflake(threadId, 'thread id')}/thread-members/@me`, { method: 'PUT', expectBody: false, signal });
  }

  leaveThread({ threadId, signal } = {}) {
    return this.#request(`channels/${snowflake(threadId, 'thread id')}/thread-members/@me`, { method: 'DELETE', expectBody: false, signal });
  }

  getMessage({ channelId, messageId, signal } = {}) {
    return this.#request(
      `channels/${snowflake(channelId, 'channel id')}/messages/${snowflake(messageId, 'message id')}`,
      { method: 'GET', signal },
    );
  }

  getThread({ threadId, signal } = {}) {
    return this.getChannel({ channelId: snowflake(threadId, 'thread id'), signal });
  }

  // Discord lists active threads at guild scope; callers filter parent_id for a channel.
  listActiveThreads({ guildId, signal } = {}) {
    return this.#request(`guilds/${snowflake(guildId, 'guild id')}/threads/active`, {
      method: 'GET', signal,
    });
  }

  // Return Discord's has_more and thread metadata intact for explicit pagination.
  listArchivedThreads({ channelId, before, limit, visibility = 'public', signal } = {}) {
    if (!['public', 'private', 'joined-private'].includes(visibility)) throw new TypeError('Invalid archived thread visibility');
    const query = new URLSearchParams();
    if (before !== undefined) {
      query.set('before', visibility === 'joined-private' ? snowflake(before, 'thread cursor') : timestamp(before));
    }
    if (limit !== undefined) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError('Discord archived thread limit must be an integer from 1 to 100');
      }
      query.set('limit', String(limit));
    }
    const suffix = query.size ? `?${query}` : '';
    const archivePath = visibility === 'joined-private' ? 'users/@me/threads/archived/private' : `threads/archived/${visibility}`;
    return this.#request(`channels/${snowflake(channelId, 'channel id')}/${archivePath}${suffix}`, {
      method: 'GET', signal,
    });
  }

  createThread({ channelId, name, type = 11, invitable, autoArchiveDuration, rateLimitPerUser, auditReason, signal } = {}) {
    if (![11, 12].includes(type)) throw new TypeError('Thread type must be public (11) or private (12)');
    const body = { name: threadName(name), type, ...threadOptions({ autoArchiveDuration, rateLimitPerUser }) };
    if (invitable !== undefined) {
      if (type !== 12) throw new TypeError('invitable requires a private thread');
      body.invitable = booleanValue(invitable, 'invitable');
    }
    if (signal?.aborted) throw abortReason(signal);
    return this.#request(`channels/${snowflake(channelId, 'channel id')}/threads`, {
      method: 'POST', body, auditReason, signal,
    });
  }

  createForumThread({ channelId, name, content, autoArchiveDuration, rateLimitPerUser, appliedTags, auditReason, signal } = {}) {
    if (typeof content !== 'string' || !content.trim() || content.length > 2000) {
      throw new TypeError('Discord forum starter content must contain 1-2000 characters');
    }
    const body = {
      name: threadName(name),
      ...threadOptions({ autoArchiveDuration, rateLimitPerUser }),
      message: { content, allowed_mentions: { parse: [], replied_user: false } },
    };
    if (appliedTags !== undefined) {
      if (!Array.isArray(appliedTags) || appliedTags.length > 5 || new Set(appliedTags).size !== appliedTags.length) {
        throw new TypeError('Discord forum tags must be an array of at most 5 unique tag ids');
      }
      body.applied_tags = appliedTags.map(id => snowflake(id, 'tag id'));
    }
    if (signal?.aborted) throw abortReason(signal);
    return this.#request(`channels/${snowflake(channelId, 'channel id')}/threads`, {
      method: 'POST', body, auditReason, signal,
    });
  }

  updateThread({ threadId, name, archived, locked, invitable, appliedTags, autoArchiveDuration, rateLimitPerUser, auditReason, signal } = {}) {
    const body = threadOptions({ autoArchiveDuration, rateLimitPerUser });
    if (name !== undefined) body.name = threadName(name);
    if (appliedTags !== undefined) body.applied_tags = appliedTagIds(appliedTags);
    for (const [key, value] of Object.entries({ archived, locked, invitable })) {
      if (value === undefined) continue;
      if (typeof value !== 'boolean') throw new TypeError(`Discord thread ${key} must be boolean`);
      body[key] = value;
    }
    if (!Object.keys(body).length) throw new TypeError('Discord thread update requires at least one field');
    if (signal?.aborted) throw abortReason(signal);
    return this.#request(`channels/${snowflake(threadId, 'thread id')}`, {
      method: 'PATCH', body, auditReason, signal,
    });
  }

  startThreadFromMessage({ channelId, messageId, name, autoArchiveDuration, rateLimitPerUser, auditReason, signal } = {}) {
    const threadName = cleanString(name);
    if (!threadName || [...threadName].length > 100) {
      throw new TypeError('Discord thread name must contain 1-100 characters');
    }
    if (signal?.aborted) throw abortReason(signal);
    return this.#request(
      `channels/${snowflake(channelId, 'channel id')}/messages/${snowflake(messageId, 'message id')}/threads`,
      {
        method: 'POST',
        signal,
        auditReason,
        body: { name: threadName, ...threadOptions({ autoArchiveDuration, rateLimitPerUser }) },
      },
    );
  }

  createMessage({ channelId, content, components, replyToMessageId, signal, retry = true }) {
    return this.#request(`channels/${snowflake(channelId, 'channel id')}/messages`, {
      method: 'POST',
      signal,
      retry,
      body: {
        content,
        ...(components === undefined ? {} : { components }),
        allowed_mentions: { parse: [], replied_user: false },
        ...(replyToMessageId ? {
          message_reference: {
            message_id: snowflake(replyToMessageId, 'message id'),
            channel_id: snowflake(channelId, 'channel id'),
            fail_if_not_exists: false,
          },
        } : {}),
      },
    });
  }

  async createFileMessage({ channelId, file, replyToMessageId, signal }) {
    if (!file || typeof file !== 'object'
      || typeof file.fileName !== 'string' || !file.fileName
      || !Buffer.isBuffer(file.bytes)) {
      throw new TypeError('A Discord attachment is required');
    }
    const deliverySeed = cleanString(file.deliveryKey) ?? cleanString(file.artifactId);
    const nonce = deliverySeed
      ? createHash('sha256').update(deliverySeed).digest('hex').slice(0, 25)
      : undefined;
    const payload = new FormData();
    payload.append('payload_json', JSON.stringify({
      allowed_mentions: { parse: [], replied_user: false },
      attachments: [{ id: 0, filename: file.fileName }],
      ...(nonce ? { nonce, enforce_nonce: true } : {}),
      ...(replyToMessageId ? {
        message_reference: {
          message_id: snowflake(replyToMessageId, 'message id'),
          channel_id: snowflake(channelId, 'channel id'),
          fail_if_not_exists: false,
        },
      } : {}),
    }));
    payload.append(
      'files[0]',
      new Blob([file.bytes], { type: file.mediaType ?? 'application/octet-stream' }),
      file.fileName,
    );
    const targetChannelId = snowflake(channelId, 'channel id');
    if (signal?.aborted) throw abortReason(signal);
    const uploadSignal = requestSignal(signal, this.#fileUploadTimeoutMs);
    try {
      return await this.#request(`channels/${targetChannelId}/messages`, {
        method: 'POST',
        signal: uploadSignal,
        timeoutMs: this.#fileUploadTimeoutMs,
        body: payload,
        multipart: true,
      });
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (error?.code?.startsWith?.('discord-')) {
        throw discordArtifactProviderError(error);
      }
      throw uncertainDiscordDelivery(error);
    }
  }

  editMessage({ channelId, messageId, content, components, signal }) {
    return this.#request(
      `channels/${snowflake(channelId, 'channel id')}/messages/${snowflake(messageId, 'message id')}`,
      {
        method: 'PATCH',
        signal,
        body: { content, ...(components === undefined ? {} : { components }), allowed_mentions: { parse: [], replied_user: false } },
      },
    );
  }

  sendTyping({ channelId, signal }) {
    return this.#request(`channels/${snowflake(channelId, 'channel id')}/typing`, {
      method: 'POST',
      signal,
      expectBody: false,
      retry: false,
      preserveRetryAfterHeader: true,
    });
  }

  async addOwnReaction({ channelId, messageId, emoji, signal } = {}) {
    const normalizedEmoji = reactionEmoji(emoji);
    await this.#request(
      `channels/${snowflake(channelId, 'channel id')}/messages/${snowflake(messageId, 'message id')}`
        + `/reactions/${encodeURIComponent(normalizedEmoji)}/@me`,
      {
        method: 'PUT',
        signal,
        expectBody: false,
        retry: false,
      },
    );
    return normalizedEmoji;
  }

  removeOwnReaction({ channelId, messageId, emoji, signal } = {}) {
    const normalizedEmoji = reactionEmoji(emoji);
    return this.#request(
      `channels/${snowflake(channelId, 'channel id')}/messages/${snowflake(messageId, 'message id')}`
        + `/reactions/${encodeURIComponent(normalizedEmoji)}/@me`,
      {
        method: 'DELETE',
        signal,
        expectBody: false,
        retry: false,
      },
    );
  }

  async #request(path, {
    method,
    body,
    signal,
    timeoutMs = 15_000,
    expectBody = true,
    retry = true,
    multipart = false,
    auditReason,
    preserveRetryAfterHeader = false,
  }) {
    if (signal?.aborted) throw abortReason(signal);
    let auditHeader;
    if (auditReason !== undefined) {
      if (typeof auditReason !== 'string' || !auditReason.trim() || [...auditReason].length > 512) throw new TypeError('Audit reason must contain 1-512 characters');
      auditHeader = encodeURIComponent(auditReason);
    }
    let response;
    try {
      response = await this.#fetch(new URL(path, this.#baseUrl), {
        method,
        headers: {
          authorization: `Bot ${this.#token}`,
          ...(auditHeader === undefined ? {} : { 'X-Audit-Log-Reason': auditHeader }),
          ...(multipart ? {} : { 'content-type': 'application/json' }),
          'user-agent': 'DeepSeek-Harness-dsh-im (https://github.com/xmanrui/dsh-im, 1.1.0)',
        },
        ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
        signal: requestSignal(signal, timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error;
      throw new Error(`Discord ${method} transport failed`, { cause: error });
    }

    let parsed = null;
    if (expectBody || response.status === 429 || !response.ok) {
      try {
        parsed = await response.json();
      } catch (cause) {
        if (expectBody) {
          const error = new Error(`Discord ${method} returned invalid JSON`, { cause });
          error.status = response?.status;
          throw error;
        }
      }
    }
    if (response.status === 429 && retry) {
      const retryAfterMs = Math.min(10_000, Math.max(50, Number(parsed?.retry_after) * 1_000 || 1_000));
      await delay(retryAfterMs, signal);
      return this.#request(path, {
        method, body, signal, timeoutMs, expectBody, retry: false, multipart, auditReason,
      });
    }
    if (!response.ok) {
      const error = new Error(cleanString(parsed?.message) ?? `Discord API failed with HTTP ${response.status}`);
      error.code = `discord-${response.status}`;
      error.status = response.status;
      if (Number.isInteger(parsed?.code) || typeof parsed?.code === 'string') {
        error.providerCode = parsed.code;
      }
      let retryAfter = Number(parsed?.retry_after);
      if (response.status === 429 && preserveRetryAfterHeader) {
        const header = response.headers?.get?.('retry-after')?.trim();
        if (header) {
          const seconds = /^\d+(?:\.\d+)?$/.test(header)
            ? Number(header)
            : Math.max(0, (Date.parse(header) - Date.now()) / 1_000);
          if (Number.isFinite(seconds) && seconds >= 0) {
            retryAfter = Math.max(Number.isFinite(retryAfter) ? retryAfter : 0, seconds);
          }
        }
      }
      if (Number.isFinite(retryAfter) && retryAfter >= 0) {
        error.retry_after = retryAfter;
        error.retryAfter = retryAfter;
      }
      throw error;
    }
    return expectBody ? parsed : null;
  }
}

export async function inspectDiscordToken(token, options = {}) {
  const api = new DiscordApi({ token, ...options });
  const bot = await api.getCurrentUser();
  if (!bot?.id || bot?.bot !== true) throw new Error('Discord token does not belong to a bot');
  return {
    platformId: String(bot.id),
    name: cleanString(bot.global_name) ?? cleanString(bot.username) ?? t('Discord机器人'),
    username: cleanString(bot.username),
  };
}

/** Owner lookup is optional metadata, bounded separately from Gateway startup. */
export async function inspectDiscordOwner(token, {
  platformId,
  timeoutMs = 5_000,
  signal,
  ...options
} = {}) {
  const api = new DiscordApi({ token, ...options });
  const lookupSignal = requestSignal(signal, positiveTimeout(timeoutMs, 'owner lookup timeout'));
  const request = { signal: lookupSignal, retry: false };
  const application = await api.getCurrentApplication(request);
  const bot = application?.bot ?? await api.getCurrentUser(request);
  if ((!application?.bot && bot?.bot !== true) || bot?.bot === false
    || snowflake(bot?.id, 'bot id') !== platformId) {
    throw new Error('Discord application does not belong to the configured bot');
  }
  // A team application belongs to its team owner, not every developer or the
  // synthetic application owner that Discord can return for team applications.
  const ownerUserId = snowflake(application?.team != null
    ? application.team.owner_user_id
    : application?.owner?.id, 'owner id');
  if (ownerUserId === platformId || (application?.owner?.bot === true && application?.team == null)) {
    throw new Error('Discord application owner is not a human identity');
  }
  lookupSignal.throwIfAborted();
  return ownerUserId;
}
