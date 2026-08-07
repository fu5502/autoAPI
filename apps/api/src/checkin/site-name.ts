import type { AdapterType, Site } from './types.js'

const knownNamesByHostname: Record<string, string> = {
  'cdk.hybgzs.com': '黑与白福利站',
  'api-welfalre.fengwind.com': 'Fengwind 福利站',
  'dy.chybenzun.top': 'CHY 流量签到',
  'token.dialoguedui.com': 'Sub2API',
}

const knownNamesByAdapter: Partial<Record<AdapterType, string>> = {
  'hybgzs-welfare': '黑与白福利站',
  'fengwind-welfare': 'Fengwind 福利站',
  'chy-traffic': 'CHY 流量签到',
  sub2api: 'Sub2API',
}

function hostnameOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return null
  }
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.replace(/\s+/g, ' ').trim().slice(0, 80)
  if (!name) return null
  // Do not turn generic login/error labels into a site name.
  if (/^(?:登录|登录页|登陆|登陆页|sign\s*in|log\s*in|login|error|404|not\s*found)$/i.test(name)) return null
  return name
}

export function resolveOfficialSiteName(baseUrl: string, adapter: AdapterType = 'unknown', apiName?: unknown): string | null {
  const adapterName = knownNamesByAdapter[adapter]
  if (adapterName) return adapterName
  const hostname = hostnameOf(baseUrl)
  if (hostname && knownNamesByHostname[hostname]) return knownNamesByHostname[hostname]
  return cleanName(apiName)
}

export function initialSiteName(baseUrl: string, requestedName?: string): string {
  return cleanName(requestedName) ?? resolveOfficialSiteName(baseUrl) ?? hostnameOf(baseUrl) ?? baseUrl
}

export function shouldRefreshGeneratedSiteName(site: Site): boolean {
  const current = site.name.trim().toLowerCase()
  const hostname = hostnameOf(site.baseUrl)
  return !current || current === hostname || current === `www.${hostname}`
}

export function officialNameForAuth(site: Site, apiName?: unknown): string {
  const name = resolveOfficialSiteName(site.baseUrl, site.adapter, apiName)
  if (!name || (!shouldRefreshGeneratedSiteName(site) && !knownNamesByAdapter[site.adapter])) return site.name
  return name
}
