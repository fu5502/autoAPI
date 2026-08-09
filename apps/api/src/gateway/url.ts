export function apiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const baseVersion = base.match(/\/(v1beta|v1)$/)?.[1] ?? null;
  const pathVersion = normalizedPath.match(/^\/(v1beta|v1)(?=\/)/)?.[1] ?? null;
  if (baseVersion && pathVersion) {
    // The base already carries a version segment. Drop it so a base like
    // ".../v1" combined with a "/v1beta/..." path does not become
    // ".../v1/v1beta/...". The path's own version segment wins.
    const baseWithoutVersion = base.slice(0, base.length - (baseVersion.length + 1));
    return `${baseWithoutVersion}${normalizedPath}`;
  }
  return `${base}${normalizedPath}`;
}
