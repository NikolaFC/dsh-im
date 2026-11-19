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
  const publishMutation = async (receipt) => {
    if (typeof options.onGoalMutation !== 'function') return;
    const ref = receipt?.ref ?? receipt;
    if (typeof ref?.id !== 'string' || !ref.id || !Number.isSafeInteger(ref.revision) || ref.revision <= 0) return;
    const goalStartSeq = options.goalMutationSequence?.(sessionId, parsed.action, ref);
    if (!Number.isSafeInteger(goalStartSeq) || goalStartSeq < 0) return;
    await options.onGoalMutation({ goalId: ref.id, revision: ref.revision, goalStartSeq });
  };
  let goal = await invoke('get');
  if (parsed.action === 'create') {
    // create itself rejects any unfinished current goal, including concurrent changes.
    const receipt = await invoke('create', { request: parsed.request });
    await publishMutation(receipt);
    const observed = await invoke('get');
    const created = receipt?.ref ?? receipt;
    // A follow-up read may race another mutation. Keep the created identity.
    goal = typeof created?.id === 'string' && observed?.id !== created.id
      ? { ...parsed.request, id: created.id, revision: created.revision, phase: 'active', activation: 'armed', roundsStarted: 0 }
      : observed;
  } else if (parsed.action === 'pause' || parsed.action === 'resume') {
    if (!goal) return result(t('当前会话尚未设置目标。'), null, 'error');
    goal = await invoke(parsed.action, { ref: { id: goal.id, revision: goal.revision } });
    if (parsed.action === 'resume') await publishMutation(goal);
  }
  const hint = parsed.action === 'pause'
    ? t('已暂停自动续轮；当前正在执行的回复不会被中断。')
    : t(GOAL_USAGE);
  return result(`${formatGoalStatus(goal)}\n\n${hint}`, goal);
}
