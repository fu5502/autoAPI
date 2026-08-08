function hasValue(value) {
  return typeof value === 'string'
    ? value.trim().length > 0
    : value !== null && value !== undefined
}

export function hasLikelyAuthState(cookies, storageItems) {
  if (Array.isArray(cookies) && cookies.some((cookie) => hasValue(cookie?.value))) return true
  if (!storageItems || typeof storageItems !== 'object') return false
  return Object.values(storageItems).some(hasValue)
}
