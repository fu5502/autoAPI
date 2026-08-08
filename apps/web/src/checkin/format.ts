import type { AuthStatus, CheckinStatus, Site } from './shared/types'

export function formatAmount(value: number | null | undefined, symbol = '$'): string {
  if (value === null || value === undefined) return '--'
  const digits = Math.abs(value) < 0.01 && value !== 0 ? 4 : 2
  const amount = Math.abs(value).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return `${value > 0 ? '+' : ''}${formatUnitValue(amount, symbol)}`
}

export function formatBalance(value: number | null | undefined, symbol = '$'): string {
  if (value === null || value === undefined) return '--'
  const amount = value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
  return formatUnitValue(amount, symbol)
}

export function isLowBalance(value: number | null | undefined): boolean {
  return value !== null && value !== undefined && Number.isFinite(value) && value <= 1
}

export function formatRewardTotals(totals: Record<string, number>): string {
  return formatRewardTotalItems(totals).join(' · ') || '--'
}

export function formatBalanceTotals(sites: Array<Pick<Site, 'lastBalanceAmount' | 'currencySymbol'>>): string {
  return formatBalanceTotalItems(sites).join(' · ') || '--'
}

export function formatRewardTotalItems(totals: Record<string, number>): string[] {
  return Object.entries(totals).map(([symbol, total]) => formatAmount(total, symbol))
}

export function formatBalanceTotalItems(sites: Array<Pick<Site, 'lastBalanceAmount' | 'currencySymbol'>>): string[] {
  const totals = new Map<string, number>()
  for (const site of sites) {
    if (site.lastBalanceAmount === null) continue
    totals.set(site.currencySymbol, (totals.get(site.currencySymbol) ?? 0) + site.lastBalanceAmount)
  }
  return [...totals.entries()].map(([symbol, total]) => formatBalance(total, symbol))
}

export function formatDateTime(value: string | null | undefined, style: 'full' | 'time' = 'full'): string {
  if (!value) return '--'
  const date = new Date(value)
  if (style === 'time') return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

export function formatDate(value: Date = new Date()): string {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(value)
}

export function rewardTimingLabel(value: string | null | undefined, now: Date = new Date()): string {
  if (!value) return '暂无成功记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  const dayFormatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  })
  const time = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
  if (dayFormatter.format(date) === dayFormatter.format(now)) return `今日 ${time}`
  const day = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
  }).format(date)
  return `上次 ${day} ${time}`
}

export function rewardTimingTone(value: string | null | undefined, now: Date = new Date()): 'today' | 'previous' | 'unknown' {
  if (!value) return 'unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'unknown'
  const dayFormatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  })
  return dayFormatter.format(date) === dayFormatter.format(now) ? 'today' : 'previous'
}

export function authLabel(status: AuthStatus): string {
  return {
    unknown: '未授权', authorizing: '授权中', valid: '登录有效', expired: '登录失效', manual_required: '需人工处理',
  }[status]
}

export function checkinLabel(status: CheckinStatus): string {
  return {
    never: '未签到', running: '执行中', cancelled: '已终止', success: '已签到', already_checked: '已签到', failed: '签到失败',
    manual_required: '需手动签到', disabled: '未签到',
  }[status]
}

export function siteCheckinLabel(site: Site): string {
  if (site.lastStatus === 'running') return '执行中'
  if (site.lastStatus === 'cancelled') return '已终止'
  if (site.lastStatus === 'failed') return '签到失败'
  if (site.lastStatus === 'manual_required') return '需手动签到'
  if (
    site.lastStatus === 'success'
    || site.lastStatus === 'already_checked'
    || (site.lastStatus === 'disabled' && site.lastRewardAt)
  ) return '已签到'
  return '未签到'
}

export function siteCheckinTone(site: Site): ReturnType<typeof statusTone> {
  if (site.lastStatus === 'running') return 'running'
  if (site.lastStatus === 'cancelled') return 'neutral'
  if (site.lastStatus === 'failed') return 'danger'
  if (site.lastStatus === 'manual_required') return 'warning'
  if (
    site.lastStatus === 'success'
    || site.lastStatus === 'already_checked'
    || (site.lastStatus === 'disabled' && site.lastRewardAt)
  ) return 'success'
  return 'neutral'
}

export function statusTone(status: AuthStatus | CheckinStatus): 'success' | 'warning' | 'danger' | 'neutral' | 'running' {
  if (['valid', 'success', 'already_checked'].includes(status)) return 'success'
  if (['manual_required', 'expired', 'disabled'].includes(status)) return 'warning'
  if (status === 'failed') return 'danger'
  if (['running', 'authorizing'].includes(status)) return 'running'
  return 'neutral'
}

export function siteAmount(site: Site, value: number | null | undefined) {
  return formatAmount(value, site.currencySymbol)
}

function formatUnitValue(value: string, symbol: string) {
  return /^(?:KB|MB|GB|TB|PB|白晶)$/i.test(symbol) ? `${value} ${symbol}` : `${symbol}${value}`
}
