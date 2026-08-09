function hasValue(value) {
  return typeof value === 'string'
    ? value.trim().length > 0
    : value !== null && value !== undefined
}

const AUTH_TOKEN_KEYS = new Set([
  'auth_token',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'sub2api_token',
  'token',
])
const NEW_API_UID_KEYS = new Set(['uid', 'user_id', 'userid', 'new-api-user'])

export function hasLikelyAuthState(cookies, storageItems, hostname) {
  const host = normalizeHostname(hostname)
  if (host === 'token.dialoguedui.com') {
    return hasSub2ApiAuthStorage(storageItems)
  }
  if (host === 'chybenzun.top' || host === 'www.chybenzun.top') {
    return hasNewApiAuthStorage(storageItems)
  }
  return hasGenericLikelyAuthState(cookies, storageItems)
}

function hasGenericLikelyAuthState(cookies, storageItems) {
  if (Array.isArray(cookies) && cookies.some((cookie) => hasValue(cookie?.value))) return true
  if (!storageItems || typeof storageItems !== 'object') return false
  return Object.values(storageItems).some(hasValue)
}

function hasSub2ApiAuthStorage(storageItems) {
  if (!storageItems || typeof storageItems !== 'object') return false
  return Object.entries(storageItems).some(([key, value]) => {
    const normalizedKey = String(key).toLowerCase()
    if (AUTH_TOKEN_KEYS.has(normalizedKey) && hasMeaningfulValue(value)) return true
    return (normalizedKey === 'auth_user' || normalizedKey === 'user') && hasRealUser(value)
  })
}

function hasNewApiAuthStorage(storageItems) {
  if (!storageItems || typeof storageItems !== 'object') return false
  return Object.entries(storageItems).some(([key, value]) => {
    const normalizedKey = String(key).toLowerCase()
    if (NEW_API_UID_KEYS.has(normalizedKey) && positiveNumber(value)) return true
    if (AUTH_TOKEN_KEYS.has(normalizedKey) && hasMeaningfulValue(value)) return true
    if (normalizedKey === 'localapi_user_token' && hasMeaningfulValue(value)) return true
    return (normalizedKey === 'user' || normalizedKey === 'auth_user') && hasRealUser(value)
  })
}

function hasRealUser(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    return false
  }
  const candidates = [parsed, parsed?.user, parsed?.state?.user, parsed?.data, parsed?.data?.user]
  return candidates.some((candidate) => candidate && typeof candidate === 'object'
    && (positiveNumber(candidate.id ?? candidate.uid ?? candidate.user_id)
      || meaningfulName(candidate.username)
      || meaningfulName(candidate.display_name)
      || meaningfulName(candidate.email)))
}

function hasMeaningfulValue(value) {
  if (typeof value !== 'string') return value !== null && value !== undefined
  const trimmed = value.trim()
  if (!trimmed) return false
  return !/^(?:null|undefined|false|0|-1|guest|anonymous|public)$/i.test(trimmed)
}

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0
}

function meaningfulName(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false
  const trimmed = String(value).trim()
  return Boolean(trimmed) && !/^(?:null|undefined|0|-1|guest|anonymous|public)$/i.test(trimmed)
}

function normalizeHostname(value) {
  return String(value || '').toLowerCase().replace(/\.$/, '')
}
