import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DiscordApi } from '../../src/channels/discord/discord-api.mjs';

const SATOSHI_CAPITAL_GUILD = '1468696024829792310';
function assertGuild(channel) {
  if (channel.guild_id !== SATOSHI_CAPITAL_GUILD) throw new Error('Thread management is limited to Satoshi Capital');
  return channel;
}
function receipt(thread, messageId) {
  return { thread, threadSnapshot: 'creation', ...(messageId ? { messageId, initialMessageDelivery: { status: 'confirmed', messageId } } : {}), url: `https://discord.com/channels/${thread.guild_id}/${thread.id}${messageId ? `/${messageId}` : ''}` };
}
function contentRequired(content) {
  if (typeof content !== 'string' || !content.trim() || content.length > 2000) throw new Error('Content must contain 1-2000 characters');
}
export async function discordThreadOperation(api, args, signal) {
  const { action, channelId, threadId, name, content, archived, locked, before, limit, visibility = 'public', messageId, userId, after, auditReason, autoArchiveDuration, rateLimitPerUser, appliedTags, invitable } = args;
  if (action === 'inspect') return assertGuild(await api.getChannel({ channelId: threadId ?? channelId, signal }));
  if (action === 'list') {
    const parent = assertGuild(await api.getChannel({ channelId, signal }));
    if (![0,5,15,16].includes(parent.type)) throw new Error('Channel cannot contain threads');
    const active = await api.listActiveThreads({ guildId: parent.guild_id, signal });
    const past = await api.listArchivedThreads({ channelId, before, limit, visibility, signal });
    return { active: active.threads.filter(t => t.parent_id === channelId), archived: past.threads, visibility, hasMoreArchived: past.has_more, nextBefore: (visibility === 'joined-private' ? past.threads.at(-1)?.id : past.threads.at(-1)?.thread_metadata?.archive_timestamp) ?? null };
  }
  if (action === 'create') {
    if (!messageId) contentRequired(content);
    else if (content !== undefined) contentRequired(content);
    const parent = assertGuild(await api.getChannel({ channelId, signal }));
    const options = { channelId, name, autoArchiveDuration, rateLimitPerUser, auditReason, signal };
    if ([15,16].includes(parent.type)) {
      if (messageId || visibility !== 'public' || invitable !== undefined) throw new Error('Forum posts must be public with their own starter');
      if ((parent.flags & 16) && !appliedTags?.length) throw new Error('This forum requires appliedTags; inspect available_tags first');
      const thread = await api.createForumThread({ ...options, content, appliedTags });
      return receipt(thread, thread.message?.id);
    }
    if (![0,5].includes(parent.type)) throw new Error('Use a text, announcement or forum channel');
    if (appliedTags !== undefined) throw new Error('Tags require a forum parent');
    if (visibility === 'joined-private') throw new Error('joined-private is a listing filter, not a creation type');
    if (parent.type === 5 && !messageId) throw new Error('Announcement threads require messageId');
    if (messageId && (visibility !== 'public' || invitable !== undefined)) throw new Error('A message-based thread must be public');
    const thread = messageId
      ? await api.startThreadFromMessage({ ...options, messageId })
      : await api.createThread({ ...options, type: visibility === 'private' ? 12 : 11, invitable });
    if (content === undefined) return receipt(thread);
    try {
      const message = await api.createMessage({ channelId: thread.id, content, signal });
      return receipt(thread, message.id);
    } catch (error) { return { ...receipt(thread), starterSent: null, initialMessageDelivery: { status: 'unknown' }, threadSnapshot: 'creation', error: error.message, retry: 'Inspect thread messages before retrying: delivery may have succeeded. Reuse this thread; do not create another thread.' }; }
  }
  if (['send','update','members','add-member','remove-member','join','leave','delete'].includes(action)) {
    const thread = assertGuild(await api.getThread({ threadId, signal }));
    if (![10,11,12].includes(thread.type)) throw new Error('Target is not a thread');
    if (action === 'update') {
      if (invitable !== undefined && thread.type !== 12) throw new Error('invitable requires a private thread');
      if (appliedTags !== undefined) {
        const parent = assertGuild(await api.getChannel({ channelId: thread.parent_id, signal }));
        if (![15,16].includes(parent.type)) throw new Error('Tags require a forum parent');
      }
      return api.updateThread({ threadId, name, archived, locked, autoArchiveDuration, rateLimitPerUser, appliedTags, invitable, auditReason, signal });
    }
    if (action === 'send') { contentRequired(content); return api.createMessage({ channelId: threadId, content, replyToMessageId: args.replyToMessageId, signal }); }
    if (action === 'members') {
      const members = await api.listThreadMembers({ threadId, after, limit, withMember: true, signal });
      return { members, nextAfter: members.at(-1)?.user_id ?? null, mayHaveMore: members.length === (limit ?? 100) };
    }
    if (action === 'delete') {
      if (args.confirm !== true) throw new Error('Deletion is irreversible; confirm=true requires direct user authorization');
      return api.deleteChannel({ channelId: threadId, auditReason, signal });
    }
    const methods = { 'add-member': 'addThreadMember', 'remove-member': 'removeThreadMember', join: 'joinThread', leave: 'leaveThread' };
    await api[methods[action]]({ threadId, userId, signal });
    return { success: true, action, threadId, ...(userId ? { userId } : {}) };
  }
  throw new Error('Unknown thread action');
}

export function installDiscordThreadTool(ctx, config = {}) {
  if (typeof ctx.inject !== 'function') return;
  ctx.inject(['tools'], toolCtx => {
    toolCtx.tools.register({
      name: 'dsh_discord_thread',
      description: 'Manage Satoshi Capital threads and forum posts, members and updates. Returns IDs and pagination. After uncertain writes, inspect messages before retrying. Delete is irreversible and requires direct user authorization.',
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['inspect','list','create','send','update','members','add-member','remove-member','join','leave','delete'] },
        botId: { type: 'string', description: 'Optional when exactly one Discord bot is configured.' },
        channelId: { type: 'string', description: 'Parent for list/create; channel to inspect.' },
        threadId: { type: 'string', description: 'Existing thread for other actions.' },
        name: { type: 'string', description: 'Required for create; optional for update. 1-100 characters.' },
        content: { type: 'string', description: '1-2000 characters. Required for send and create unless messageId supplied.' },
        messageId: { type: 'string', description: 'Create thread from an existing text/announcement message.' },
        visibility: { type: 'string', enum: ['public','private','joined-private'], description: 'Default public. joined-private is list-only.' },
        archived: { type: 'boolean' }, locked: { type: 'boolean' }, invitable: { type: 'boolean', description: 'Private threads only.' },
        autoArchiveDuration: { type: 'integer', enum: [60,1440,4320,10080] },
        rateLimitPerUser: { type: 'integer', minimum: 0, maximum: 21600 },
        appliedTags: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'Forum tag IDs; update [] clears tags.' },
        replyToMessageId: { type: 'string', description: 'For send: reply to a message in this same thread.' },
        userId: { type: 'string', description: 'For add-member/remove-member.' },
        after: { type: 'string', description: 'Member-list user ID cursor.' },
        before: { type: 'string', description: 'Archive timestamp, or thread ID for joined-private.' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        auditReason: { type: 'string', description: 'Optional Discord audit-log reason, up to 512 characters.' },
        confirm: { type: 'boolean', description: 'Required true for an explicitly authorized deletion.' }
      }, required: ['action'], additionalProperties: false },
      output: { schema: { type: 'object' }, render: (_a,v) => [{ type: 'text', text: JSON.stringify(v) }] },
      async execute(args, exec) {
        const home = config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
        const { bots } = JSON.parse(await readFile(join(home, 'integrations/dsh-discord/config.json'), 'utf8'));
        const bot = args.botId ? bots.find(b => b.botId === args.botId) : bots.length === 1 ? bots[0] : null;
        if (!bot) throw new Error('Specify a configured Discord botId');
        const credential = await ctx.credentials.resolve(bot.tokenRef);
        if (!credential) throw new Error('Discord credential unavailable');
        return discordThreadOperation(new DiscordApi({ token: credential.value }), args, exec.signal);
      }
    });
  });
}
