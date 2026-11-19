import { randomUUID } from 'node:crypto';
import { ConversationStateStore } from '../shared/conversation-state-store.mjs';

const routeKey = /^(?:direct|group):\d+$/u;
const positive = value => Number.isSafeInteger(value) && value > 0;
const sequence = value => Number.isSafeInteger(value) && value >= 0;
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);

function normalizeGoalOutputRoute(value) {
  if (!value || Array.isArray(value)) return null;
  const { sessionId, goalId, actor, routeId, revision, goalStartSeq, deliverySeqFloor, deliverySeqCursor } = value;
  if (![sessionId, goalId, routeId].every(identity) || typeof actor !== 'string' || !/^\d+$/u.test(actor)
    || !positive(revision) || ![goalStartSeq, deliverySeqFloor, deliverySeqCursor].every(sequence)
    || goalStartSeq > deliverySeqFloor || deliverySeqFloor > deliverySeqCursor) return null;
  return { sessionId, goalId, actor, routeId, revision, goalStartSeq, deliverySeqFloor, deliverySeqCursor };
}

export class DiscordStateStore extends ConversationStateStore {
  #saving = new Map();

  async load() {
    await super.load();
    const state = this.extensionState();
    const routes = Object.create(null);
    for (const [key, row] of Object.entries(state.goalOutputRoutes ?? {})) {
      const route = normalizeGoalOutputRoute(row);
      if (routeKey.test(key) && route && state.sessions[key] === route.sessionId) routes[key] = route;
    }
    if (Object.keys(routes).length) state.goalOutputRoutes = routes;
    else delete state.goalOutputRoutes;
    return this;
  }

  clearBindingExtension(key) {
    this.#saving.delete(key);
    const state = this.extensionState();
    if (!state.goalOutputRoutes) return;
    delete state.goalOutputRoutes[key];
    if (!Object.keys(state.goalOutputRoutes).length) delete state.goalOutputRoutes;
  }

  goalOutputRouteFor(key) {
    const route = this.extensionState().goalOutputRoutes?.[key];
    if (!routeKey.test(key) || !route || this.#saving.get(key) === route
      || this.sessionFor(key) !== route.sessionId) return null;
    return { ...route, bindingVersion: this.controlBindingVersion(key) };
  }

  async rememberGoalOutputRoute(key, value, expectedBindingVersion) {
    const route = normalizeGoalOutputRoute({
      ...value, routeId: randomUUID(), deliverySeqCursor: value?.deliverySeqFloor,
    });
    if (!routeKey.test(key) || !route || expectedBindingVersion !== this.controlBindingVersion(key)
      || this.sessionFor(key) !== route.sessionId) return false;
    const state = this.extensionState();
    const routes = state.goalOutputRoutes ??= Object.create(null);
    const previous = routes[key];
    if (previous && previous.goalStartSeq >= route.goalStartSeq) return false;
    routes[key] = route;
    this.#saving.set(key, route);
    try {
      await this.persist();
    } catch (error) {
      if (routes[key] === route) {
        if (previous) routes[key] = previous;
        else this.clearBindingExtension(key);
        await this.persist().catch(() => {});
      }
      throw error;
    } finally {
      if (this.#saving.get(key) === route) this.#saving.delete(key);
    }
    return this.goalOutputRouteFor(key)?.routeId === route.routeId;
  }

  /** Record an attempted dispatch before calling Discord, not a delivery receipt. */
  async claimGoalOutput(key, expectedRoute, dispatchSeq) {
    const current = this.goalOutputRouteFor(key);
    if (!current || !expectedRoute || !sequence(dispatchSeq) || dispatchSeq <= current.deliverySeqCursor
      || !['routeId', 'bindingVersion', 'sessionId', 'goalId', 'actor', 'revision', 'goalStartSeq', 'deliverySeqFloor']
        .every(field => current[field] === expectedRoute[field])) return false;
    this.extensionState().goalOutputRoutes[key].deliverySeqCursor = dispatchSeq;
    await this.persist();
    return this.goalOutputRouteFor(key)?.routeId === current.routeId;
  }
}
