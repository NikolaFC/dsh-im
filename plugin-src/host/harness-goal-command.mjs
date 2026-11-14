import { parseGoalCommand, formatGoalStatus, GOAL_USAGE, GOAL_CREATE_HINT } from '../../src/channels/shared/goal-command.mjs';
import { t } from '../../src/channels/shared/i18n.mjs';

/** Explicit human IM commands only. No model prompt or inferred authorization. */
export async function executeHarnessGoalCommand(gateway, peer, sessionId, line, options = {}) {
  const parsed = parseGoalCommand(line);
  if (!parsed) return undefined;
  const result = (text, goal, kind = 'success') => ({ result: { kind, text }, goal: goal ?? null });
  if (parsed.action === 'invalid') return result(t(GOAL_USAGE), null, 'error');
  if (parsed.action === 'help') return result(t(GOAL_CREATE_HINT));
  const invoke = (method, args = {}) => {
    options.signal?.throwIfAborted();
    options.assertSessionBound?.();
    return gateway.invoke({ namespace: 'goals', method, args: { agentId: sessionId, ...args },
      signal: options.signal, ...(peer === undefined ? {} : { peer }) });
  };
  let goal = await invoke('get');
  if (parsed.action === 'create') {
    // create itself rejects any unfinished current goal, including concurrent changes.
    await invoke('create', { request: parsed.request });
    goal = await invoke('get');
  } else if (parsed.action === 'pause' || parsed.action === 'resume') {
    if (!goal) return result(t('当前会话尚未设置目标。'), null, 'error');
    goal = await invoke(parsed.action, { ref: { id: goal.id, revision: goal.revision } });
  }
  const hint = parsed.action === 'pause'
    ? t('已暂停自动续轮；当前正在执行的回复不会被中断。')
    : t(GOAL_USAGE);
  return result(`${formatGoalStatus(goal)}\n\n${hint}`, goal);
}
