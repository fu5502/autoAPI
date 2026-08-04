import type { GatewayRequest, RoutingCandidate } from "../domain/types.js";
import type { AdapterRegistry } from "./adapter.js";

export function eligibleCandidates(
  candidates: RoutingCandidate[],
  request: GatewayRequest,
  registry: AdapterRegistry,
  now = Date.now(),
): RoutingCandidate[] {
  return candidates.filter(({ channel }) => {
    if (!channel.enabled || channel.status === "disabled" || channel.status === "isolated" || channel.status === "pending") return false;
    if (channel.cooldownUntil && Date.parse(channel.cooldownUntil) > now) return false;
    if (channel.balanceStatus === "exhausted") return false;
    if (channel.balance !== null && channel.minBalance !== null && channel.balance < channel.minBalance) return false;
    return registry.forChannel(channel.protocol).supports(request);
  });
}

export function orderCandidates(candidates: RoutingCandidate[], counter: number): RoutingCandidate[] {
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
    const total = group.reduce((sum, candidate) => sum + effectiveWeight(candidate), 0);
    let cursor = total > 0 ? counter % total : 0;
    let selectedIndex = 0;
    for (let index = 0; index < group.length; index += 1) {
      cursor -= effectiveWeight(group[index]!);
      if (cursor < 0) {
        selectedIndex = index;
        break;
      }
    }
    ordered.push(group[selectedIndex]!, ...group.filter((_, index) => index !== selectedIndex).sort(compareQuality));
  }
  return ordered;
}

function effectiveWeight(candidate: RoutingCandidate): number {
  const { channel } = candidate;
  const healthFactor = channel.status === "degraded" ? 0.4 : 1;
  const errorFactor = Math.max(0.15, 1 - channel.recentErrorRate * 0.8);
  const latencyFactor = channel.lastLatencyMs ? Math.max(0.5, 1_000 / Math.max(1_000, channel.lastLatencyMs)) : 1;
  return Math.max(1, Math.round(channel.weight * healthFactor * errorFactor * latencyFactor));
}

function compareQuality(a: RoutingCandidate, b: RoutingCandidate): number {
  if (a.channel.status !== b.channel.status) return a.channel.status === "healthy" ? -1 : 1;
  if (a.channel.recentErrorRate !== b.channel.recentErrorRate) return a.channel.recentErrorRate - b.channel.recentErrorRate;
  return (a.channel.lastLatencyMs ?? Number.MAX_SAFE_INTEGER) - (b.channel.lastLatencyMs ?? Number.MAX_SAFE_INTEGER);
}
