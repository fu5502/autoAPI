export function apiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (base.endsWith("/v1") && normalizedPath.startsWith("/v1/")) {
    return `${base}${normalizedPath.slice(3)}`;
  }
  if (base.endsWith("/v1beta") && normalizedPath.startsWith("/v1beta/")) {
    return `${base}${normalizedPath.slice(7)}`;
  }
  return `${base}${normalizedPath}`;
}
