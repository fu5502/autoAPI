import type { GatewayRequest, RoutingCandidate } from "../domain/types.js";
import type { RoutingHint } from "../runtime/runtime-state.js";
import type { AdapterRegistry } from "./adapter.js";

export function eligibleCandidates(
  candidates: RoutingCandidate[],
  request: GatewayRequest,
  registry: AdapterRegistry,
  now = Date.now(),
): RoutingCandidate[] {
  return candidates.filter(({ channel }) => {
    if (!channel.enabled || channel.status === "disabled" || channel.status === "isolated") return false;
    if (channel.cooldownUntil && Date.parse(channel.cooldownUntil) > now) return false;
    if (channel.balanceStatus === "exhausted") return false;
    if (channel.balance !== null && channel.minBalance !== null && channel.balance < channel.minBalance) return false;
    return registry.forChannel(channel.protocol).supports(request);
  });
}

export function orderCandidates(candidates: RoutingCandidate[], counter: number, hint: RoutingHint = { preferredChannelId: null, channelPenalties: {} }): RoutingCandidate[] {
  const preferred = hint.preferredChannelId
    ? candidates.find((candidate) => candidate.channel.id === hint.preferredChannelId && penaltyTier(candidate, hint) === 0) ?? null
    : null;
  const remaining = preferred ? candidates.filter((candidate) => candidate !== preferred) : candidates;
  const tiers = new Map<number, RoutingCandidate[]>();
  for (const candidate of remaining) {
    const tier = penaltyTier(candidate, hint);
    const group = tiers.get(tier) ?? [];
    group.push(candidate);
    tiers.set(tier, group);
  }

  const ordered = preferred ? [preferred] : [];
  for (const tier of [...tiers.keys()].sort((a, b) => a - b)) {
    ordered.push(...orderTier(tiers.get(tier)!, counter, hint));
  }
  return ordered;
}

function orderTier(candidates: RoutingCandidate[], counter: number, hint: RoutingHint): RoutingCandidate[] {
  const priorityGroups = new Map<number, RoutingCandidate[]>();
  for (const candidate of candidates) {
    const group = priorityGroups.get(candidate.channel.priority) ?? [];
    group.push(candidate);
    priorityGroups.set(candidate.channel.priority, group);
  }
  const priorities = [...priorityGroups.keys()].sort((a, b) => b - a);
  const ordered: RoutingCandidate[] = [];
  for (const priority of priorities) {
    const group = priorityGroups.get(priority)!;
    const total = group.reduce((sum, candidate) => sum + effectiveWeight(candidate, hint), 0);
    let cursor = total > 0 ? counter % total : 0;
    let selectedIndex = 0;
    for (let index = 0; index < group.length; index += 1) {
      cursor -= effectiveWeight(group[index]!, hint);
      if (cursor < 0) {
        selectedIndex = index;
        break;
      }
    }
    ordered.push(group[selectedIndex]!, ...group.filter((_, index) => index !== selectedIndex).sort((a, b) => compareQuality(a, b, hint)));
  }
  return ordered;
}

function effectiveWeight(candidate: RoutingCandidate, hint: RoutingHint): number {
  const { channel } = candidate;
  const healthFactor = channel.status === "degraded" ? 0.4 : 1;
  const errorFactor = Math.max(0.15, 1 - channel.recentErrorRate * 0.8);
  const latencyFactor = channel.lastLatencyMs ? Math.max(0.5, 1_000 / Math.max(1_000, channel.lastLatencyMs)) : 1;
  const penalty = Number(hint.channelPenalties[channel.id] ?? 0);
  const penaltyFactor = penalty > 0 ? 1 / (1 + penalty * 2) : 1;
  return Math.max(1, Math.round(channel.weight * healthFactor * errorFactor * latencyFactor * penaltyFactor));
}

function compareQuality(a: RoutingCandidate, b: RoutingCandidate, hint: RoutingHint): number {
  const penaltyDifference = penaltyTier(a, hint) - penaltyTier(b, hint);
  if (penaltyDifference !== 0) return penaltyDifference;
  if (a.channel.status !== b.channel.status) return a.channel.status === "healthy" ? -1 : 1;
  if (a.channel.recentErrorRate !== b.channel.recentErrorRate) return a.channel.recentErrorRate - b.channel.recentErrorRate;
  return (a.channel.lastLatencyMs ?? Number.MAX_SAFE_INTEGER) - (b.channel.lastLatencyMs ?? Number.MAX_SAFE_INTEGER);
}

function penaltyTier(candidate: RoutingCandidate, hint: RoutingHint): number {
  const runtimePenalty = Math.max(0, Math.floor(Number(hint.channelPenalties[candidate.channel.id] ?? 0)));
  return Math.max(runtimePenalty, candidate.channel.status === "degraded" ? 1 : 0);
}
