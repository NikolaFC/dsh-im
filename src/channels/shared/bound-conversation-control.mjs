import { evaluateInboundAccess } from './inbound-access.mjs';

function rejected(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

/** Process-local capability, created only below the authenticated Discord ingress.
 * No serialized flag, rpcId prefix or caller-supplied session id grants control.
 * Each capability captures one bot's exact conversation binding and is invalidated
 * by rebind (including ABA), disposal, or command permission revocation.
 */
export function createBoundConversationControl({ channel, state, key, message, accessPolicy, signal }) {
  if (channel !== 'discord' || !accessPolicy || !message?.senderId || message.senderIsBot === true
    || !['group', 'direct'].includes(message.kind)
    || (message.kind === 'group' && message.addressed !== true)
    || key !== `${message.kind}:${message.conversationId}`
    || typeof state?.controlBindingVersion !== 'function') return undefined;
  const sessionId = state.sessionFor(key);
  if (typeof sessionId !== 'string' || !sessionId) return undefined;
  const version = state.controlBindingVersion(key);
  const kind = message.kind;
  const senderIds = [message.senderId, message.senderAlternateId].filter(Boolean);
  return requestedSessionId => {
    signal?.throwIfAborted();
    if (requestedSessionId !== sessionId || state.sessionFor(key) !== sessionId
      || state.controlBindingVersion(key) !== version) rejected('workspace-session-stale');
    if (!evaluateInboundAccess(accessPolicy, { conversationType: kind, senderIds, isCommand: true }).allowed) {
      rejected('im-control-denied');
    }
    return true;
  };
}
