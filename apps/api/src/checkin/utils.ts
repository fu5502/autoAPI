export function nowIso(): string {
  return new Date().toISOString()
}

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('站点地址不能为空')

  const explicitScheme = /^([a-z][a-z\d+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase()
  if (explicitScheme && !['http', 'https'].includes(explicitScheme)) {
    throw new Error('站点地址仅支持 HTTP 或 HTTPS')
  }

  const input = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(input)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('站点地址仅支持 HTTP 或 HTTPS')
  }
  if (!url.hostname) throw new Error('站点地址无效')
  url.username = ''
  url.password = ''
  url.hash = ''
  url.search = ''
  url.pathname = '/'
  return url.toString().replace(/\/$/, '')
}

export function localDateKey(date: Date | string, timeZone = 'Asia/Shanghai'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(typeof date === 'string' ? new Date(date) : date)
}

export function quotaToAmount(raw: number | null | undefined, quotaPerUnit: number, displayScale = 1): number | null {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) return null
  const divisor = quotaPerUnit > 0 ? quotaPerUnit : 500_000
  return roundAmount((raw / divisor) * displayScale)
}

export function roundAmount(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export function safeMessage(value: unknown, fallback = '请求失败'): string {
  if (value instanceof Error) return value.message || fallback
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (value && typeof value === 'object' && 'message' in value) {
    const message = (value as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  return fallback
}

export function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}
