import { harnessPeer } from './harness-peer.mjs';
import { isGoalCommand } from '../../src/channels/shared/goal-command.mjs';
import { executeHarnessGoalCommand } from './harness-goal-command.mjs';

/** Match the actual successful mutation reference to its committed Session seq. */
function goalMutationSequence(ctx, sessionId, operation, ref) {
  try {
    const session = ctx.get?.('agents')?.get?.(sessionId)?.session ?? ctx.get?.('sessions')?.get?.(sessionId);
    if (!session || session.id !== sessionId) return undefined;
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events;
    return events?.findLast(event => event.type === 'goal/change' && event.data?.operation === operation
      && event.data.goal?.id === ref.id && event.data.goal?.revision === ref.revision)?.seq;
  } catch {
    return undefined;
  }
}

/**
 * Adapt the Host's Typert command gateway to the channel Harness client.
 * Programmatic production fixtures may omit the gateway and exercise other assembly paths.
 */
export function createHarnessCommandExecutor(ctx, provided) {
  if (provided !== undefined) {
    if (typeof provided !== 'function') throw new TypeError('commandExecutor must be a function');
    return provided;
  }
  const gateway = ctx?.typertGateway;
  if (!gateway) return undefined;
  if (typeof gateway.invoke !== 'function') {
    throw new TypeError('dsh-im requires a callable ctx.typertGateway');
  }
  const peer = harnessPeer(ctx);
  return async (sessionId, line, options = {}) => {
    if (isGoalCommand(line)) return executeHarnessGoalCommand(gateway, peer, sessionId, line, {
      ...options,
      goalMutationSequence: (id, operation, ref) => goalMutationSequence(ctx, id, operation, ref),
    });
    const request = {
      namespace: 'commands',
      method: 'execute',
      args: { agentId: sessionId, line, images: [] },
      signal: options.signal,
      ...(peer === undefined ? {} : { peer }),
    };
    try {
      return await gateway.invoke(request);
    } catch (error) {
      // Host versions use no attachments, images, or submittedAttachments.
      // Adapt only exact descriptor rejections before command dispatch, so
      // a business failure can never cause compaction to run twice.
      if (error?.name !== 'TypertGatewayError'
        || !['arguments-invalid', 'gateway/arguments-invalid'].includes(error.code)
        || error.endpoint !== 'commands/execute') {
        throw error;
      }
      let args;
      if (error.message === 'typert gateway: commands/execute: args fields do not match the descriptor: unexpected "images"') {
        args = { agentId: sessionId, line };
      } else if (error.message === 'typert gateway: commands/execute: args fields do not match the descriptor: missing "submittedAttachments"; unexpected "images"') {
        args = { agentId: sessionId, line, submittedAttachments: [] };
      } else {
        throw error;
      }
      options.signal?.throwIfAborted();
      return gateway.invoke({
        ...request,
        args,
      });
    }
  };
}
