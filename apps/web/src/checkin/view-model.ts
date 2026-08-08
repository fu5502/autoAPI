import type { AdapterType, Site } from './shared/types'

type SiteModeFields = Pick<Site, 'adapter' | 'checkinMode'>
type SiteBalanceFields = Pick<Site, 'adapter' | 'lastBalanceAmount'>

/** The server persists this mode after probing the site's actual check-in capability. */
export function isBalanceOnlySite(site: SiteModeFields): boolean {
  return site.checkinMode === 'balance_only'
}

export type SiteManagementGroup = 'welfare' | 'relay'

export function siteManagementGroup(site: SiteModeFields): SiteManagementGroup {
  return isBalanceOnlySite(site) ? 'relay' : 'welfare'
}

export function partitionSites<T extends SiteModeFields>(sites: T[]): Record<SiteManagementGroup, T[]> {
  return {
    welfare: sites.filter((site) => siteManagementGroup(site) === 'welfare'),
    relay: sites.filter((site) => siteManagementGroup(site) === 'relay'),
  }
}

const adapterLabels: Partial<Record<AdapterType, string>> = {
  'new-api-modern': 'New API 新版',
  'new-api-legacy': 'New API 旧版',
  'local-api': 'LocalAPI',
  sub2api: 'Sub2API',
  'fengwind-welfare': 'Fengwind 福利站',
  'hybgzs-welfare': '黑与白福利站',
  'chy-traffic': 'CHY 流量签到',
}

/**
 * An unknown adapter is only "待检测" while no balance has ever been read.
 * A real zero is a valid balance, so null is the only unknown sentinel here.
 */
export function siteAdapterLabel(site: SiteBalanceFields): string {
  if (site.lastBalanceAmount === null) return '待检测'
  const knownLabel = adapterLabels[site.adapter]
  return knownLabel ?? '余额已读取'
}
