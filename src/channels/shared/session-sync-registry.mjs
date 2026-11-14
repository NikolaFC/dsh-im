/** Optional per-bot card delivery. A registration is not a delivery receipt:
 * the coordinator must await the renderer before suppressing final text. */
const renderers = new Map();

function botKey({ channel, botId }) {
  return JSON.stringify([channel, botId]);
}

export function registerSessionSyncMirror(target, render) {
  const key = botKey(target);
  const entry = { render };
  renderers.set(key, entry);
  return () => {
    if (renderers.get(key) === entry) renderers.delete(key);
  };
}

/**
 * duoduo fork: bots whose chat wants mid-turn text segments of synced turns
 * (goal rounds) as they happen. A running channel registers its own bot only,
 * so a segment can never reach a bot or channel that did not opt in.
 */
const liveSegmentBots = new Map();

export function registerLiveSegmentBot(target) {
  const key = botKey(target);
  const entry = {};
  liveSegmentBots.set(key, entry);
  return () => {
    if (liveSegmentBots.get(key) === entry) liveSegmentBots.delete(key);
  };
}

export function liveSegmentsEnabled(target) {
  return Boolean(target?.channel && target?.botId) && liveSegmentBots.has(botKey(target));
}

export async function deliverSessionSyncMirror(target, sessionId, turn, text) {
  const entry = renderers.get(botKey(target));
  if (!entry) return false;
  return await entry.render({ target, sessionId, turn, text }) === true;
}
