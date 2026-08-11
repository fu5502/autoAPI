export function iconCacheKey(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `inline-${value.length}-${(hash >>> 0).toString(36)}`;
}

export function channelIconVersion(channel: {
  faviconUrl?: string | null;
  baseUrl: string;
  checkinSite?: { faviconUrl?: string | null; updatedAt?: string | null } | null;
}): string {
  const value = channel.faviconUrl || channel.checkinSite?.faviconUrl || channel.baseUrl;
  return value.startsWith("data:") ? iconCacheKey(value) : value;
}
