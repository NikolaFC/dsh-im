const pending = new Map();

/** Only the authenticated Discord command path registers an admission. */
export function beginDiscordGoalOutputAdmission(sessionId) {
  const admission = Promise.withResolvers();
  const active = pending.get(sessionId) ?? new Set();
  active.add(admission.promise);
  pending.set(sessionId, active);
  return () => {
    active.delete(admission.promise);
    if (!active.size && pending.get(sessionId) === active) pending.delete(sessionId);
    admission.resolve();
  };
}

/** A goal event can precede the Typert receipt and durable route write. */
export function waitForPendingDiscordGoalOutput(sessionId) {
  const active = pending.get(sessionId);
  if (active?.size) return Promise.all(active);
}
