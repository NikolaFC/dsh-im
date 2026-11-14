import { t } from './i18n.mjs';
import { withSessionBindingLock } from './session-binding-lock.mjs';
import { WORKSPACE_SESSION_STALE } from './workspace-session.mjs';

export const GOAL_USAGE = '用法：/goal [status|pause|resume]；创建：/goal 目标 或 /goal create [--rounds 轮数] 目标（1–256 轮）。';
export const GOAL_CREATE_HINT = '创建目标：发送 /goal 目标（也可用 /goal create [--rounds 轮数] 目标）；Discord 也可选择 action:create 并填写 objective。';
export const isGoalCommand = text => typeof text === 'string' && /^\/goal(?=$|\s)/iu.test(text.trim());

// A deliberately small human-command grammar, shared by the transport and Host.
//
// `/goal <objective>` is the short form a person types first: reserved words keep
// their meanings, anything else is the objective. `/goal create …` stays valid so
// an objective that happens to start with a reserved word, or one that needs an
// explicit round cap, still has an unambiguous spelling.
export function parseGoalCommand(text) {
  if (!isGoalCommand(text)) return null;
  const tail = text.trim().slice(5).trim();
  if (!tail) return { action: 'status' };
  if (/^(status|pause|resume)$/u.test(tail)) return { action: tail };
  if (tail === 'create') return { action: 'help' };
  if (/[\r\n\0]/u.test(tail)) return { action: 'invalid' };
  if (/^create(?=\s)/u.test(tail)) {
    const match = /^create\s+(?:--rounds\s+([1-9]\d*)\s+)?([\s\S]+)$/u.exec(tail);
    if (!match) return { action: 'invalid' };
    const objective = match[2].trim();
    const maxGoalRounds = match[1] === undefined ? 256 : Number(match[1]);
    if (!objective || objective.startsWith('--') || objective.length > 1000
      || !Number.isSafeInteger(maxGoalRounds) || maxGoalRounds < 1 || maxGoalRounds > 256) return { action: 'invalid' };
    return { action: 'create', request: { objective, maxGoalRounds } };
  }
  // A bare objective: `/goal 把论文改完` means `/goal create 把论文改完`.
  if (tail.startsWith('--') || tail.length > 1000) return { action: 'invalid' };
  return { action: 'create', request: { objective: tail, maxGoalRounds: 256 } };
}

export function formatGoalStatus(goal) {
  if (!goal) return t('当前会话尚未设置目标。');
  const phase = { active: t('进行中'), paused: t('已暂停'), blocked: t('受阻'), complete: t('已完成') }[goal.phase] ?? goal.phase;
  return t('目标：{objective}\n状态：{phase}；自动续轮：{activation}\n轮数：{rounds}/{cap}', {
    objective: goal.objective, phase, activation: goal.activation === 'armed' ? t('已启用') : t('未启用'),
    rounds: goal.roundsStarted, cap: goal.maxGoalRounds,
  }) + (goal.blockedReason?.message ? `\n${goal.blockedReason.message}` : '');
}

/**
 * A brand-new conversation (a fresh thread, a channel, or one just started with
 * /new) has no Session yet: an ordinary first message creates and binds one.
 * `/goal create` is a first message too, so it opens the Session the same way
 * instead of insisting a chat must already be bound. Binding stays inside the
 * per-conversation lock so a concurrently created Session is reused rather than
 * orphaned, and a failed creation never leaves a binding behind.
 */
async function bindNewSession(harness, state, key, options) {
  return withSessionBindingLock(state, key, async () => {
    const current = state.sessionFor(key);
    if (typeof current === 'string' && current) return current;
    const sessionId = await harness.createSession({ conversationKey: key, signal: options.signal });
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('Harness returned an invalid session id');
    if (await state.setSession(key, sessionId) === false) {
      const stale = new Error('Workspace changed while binding the new session');
      stale.code = WORKSPACE_SESSION_STALE;
      throw stale;
    }
    return sessionId;
  });
}

export async function runGoalCommand(text, harness, state, key, options = {}) {
  const parsed = parseGoalCommand(text);
  if (!parsed) return null;
  const reply = message => ({ handled: true, message });
  if (options.hasImages || options.hasFiles) return reply(t('目标命令仅支持纯文字，请移除附件后重试。'));
  if (parsed.action === 'invalid') return reply(t(GOAL_USAGE));
  if (parsed.action === 'help') return reply(t(GOAL_CREATE_HINT));
  let sessionId = state?.sessionFor?.(key);
  if (!sessionId) {
    // Reading or changing a goal needs the conversation's own Session; only an
    // explicit create may open one, so `/goal` on a fresh conversation can set
    // the objective before the first prompt.
    if (parsed.action !== 'create'
      || typeof harness?.createSession !== 'function'
      || typeof harness?.workspaceSession !== 'function'
      || typeof state?.setSession !== 'function') {
      return reply(t('当前聊天还没有绑定会话，请先发送一条消息或使用 /session 绑定会话。'));
    }
    try {
      sessionId = await bindNewSession(harness, state, key, options);
    } catch (error) {
      return reply(t('目标操作未完成（{code}），请重新查看 /goal status。', { code: error?.code ?? 'unavailable' }));
    }
  }
  // Never fall back to the global/latest session or submit a slash as a prompt.
  const session = harness?.workspaceSession?.(sessionId, key);
  if (typeof session?.executeCommand !== 'function') return reply(t('当前 Harness 暂不支持目标命令。'));
  try {
    const execution = await session.executeCommand(text.trim(), { signal: options.signal,
      assertSessionBound: () => {
        if (state.sessionFor(key) !== sessionId) throw Object.assign(new Error('Session binding changed'), { code: 'workspace-session-stale' });
      },
    });
    if (!execution || !['success', 'error'].includes(execution.result?.kind)) return reply(t('当前 Harness 暂不支持目标命令。'));
    return { handled: true, message: execution.result.text, goal: execution.goal ?? null };
  } catch (error) {
    const code = error?.code ?? error?.failure?.code ?? 'unavailable';
    return reply(t('目标操作未完成（{code}），请重新查看 /goal status。', { code }));
  }
}
