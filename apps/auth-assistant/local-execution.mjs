export const HYBGZS_LOCAL_EXECUTION_HOST = 'cdk.hybgzs.com'
export const TRUSTED_AUTOAPI_ORIGIN_KEY = 'autoapi-trusted-origin'

export const LOCAL_EXECUTION_OPERATIONS = Object.freeze([
  'balance_refresh',
  'checkin',
])

export const LOCAL_EXECUTION_STATUSES = Object.freeze([
  'success',
  'already_checked',
  'manual_required',
  'failed',
])

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isSupportedOperation(value) {
  return LOCAL_EXECUTION_OPERATIONS.includes(value)
}

function httpOrigin(value) {
  try {
    const url = new URL(String(value || '').trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url.origin
  } catch {
    return null
  }
}

export function validateTrustedLocalExecutionOrigin({ messageOrigin, senderTabUrl, trustedOrigin }) {
  const trusted = httpOrigin(trustedOrigin)
  const message = httpOrigin(messageOrigin)
  const sender = httpOrigin(senderTabUrl)
  if (!trusted) throw new Error('Configure this autoAPI origin in the extension before local execution')
  if (message !== trusted || sender !== trusted) {
    throw new Error('Local execution must be started from the configured autoAPI origin')
  }
  return trusted
}

export function isExactHybgzsUrl(value) {
  try {
    const url = new URL(String(value || '').trim())
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && url.hostname.toLowerCase().replace(/\.$/, '') === HYBGZS_LOCAL_EXECUTION_HOST
  } catch {
    return false
  }
}

export function validateLocalExecutionStart({ requestId, code, siteUrl, operation }) {
  if (!isNonEmptyString(requestId)) throw new Error('Local execution request id is invalid')
  if (!isNonEmptyString(code)) throw new Error('Local execution code is invalid')
  if (!isExactHybgzsUrl(siteUrl)) throw new Error('Local execution is only available for cdk.hybgzs.com')
  if (!isSupportedOperation(operation)) throw new Error('Local execution operation is invalid')

  return {
    requestId: requestId.trim(),
    code: code.trim().toUpperCase(),
    operation,
  }
}

export function validateLocalExecutionClaim(claim, expectedOperation, now = Date.now()) {
  if (!claim || typeof claim !== 'object') throw new Error('Local execution claim is invalid')
  if (!isNonEmptyString(claim.executionId) || !isNonEmptyString(claim.resultToken)) {
    throw new Error('Local execution claim is missing credentials')
  }
  const domain = typeof claim.domain === 'string' ? claim.domain.toLowerCase().replace(/^\.+|\.$/g, '') : ''
  if (domain !== HYBGZS_LOCAL_EXECUTION_HOST) {
    throw new Error('Local execution claim targets an unsupported host')
  }
  if (!isExactHybgzsUrl(claim.siteUrl)) throw new Error('Local execution claim has an invalid site URL')
  if (!isSupportedOperation(claim.operation) || claim.operation !== expectedOperation) {
    throw new Error('Local execution claim operation does not match the request')
  }
  const expiresAt = Date.parse(String(claim.expiresAt || ''))
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('Local execution claim has expired')

  return {
    executionId: claim.executionId.trim(),
    resultToken: claim.resultToken.trim(),
    operation: claim.operation,
    expiresAt: new Date(expiresAt).toISOString(),
  }
}

export function unwrapHybgzsResponse(payload) {
  if (!payload || typeof payload !== 'object' || payload.success === false) return null
  if (payload.data && typeof payload.data === 'object') return payload.data
  return payload
}

export function hasVerifiedHybgzsUser(payload) {
  const data = unwrapHybgzsResponse(payload)
  const id = data?.user?.id
  if (typeof id === 'number') return Number.isFinite(id) && id > 0
  return typeof id === 'string' && id.trim().length > 0 && id.trim() !== '0'
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function extractHybgzsBalanceRaw(payload) {
  const data = unwrapHybgzsResponse(payload)
  if (!data) return null
  return finiteNumber(data.balance)
    ?? finiteNumber(data.mainSite?.balance)
    ?? finiteNumber(data.total)
    ?? finiteNumber(data.wallet?.balance)
}

export function extractHybgzsRewardRaw(payload) {
  const data = unwrapHybgzsResponse(payload)
  if (!data) return null
  return finiteNumber(data.todayCheckinInfo?.rewardQuota)
    ?? finiteNumber(data.todayExpectedReward)
}

export function normalizeLocalExecutionOutcome(outcome) {
  const status = LOCAL_EXECUTION_STATUSES.includes(outcome?.status) ? outcome.status : 'failed'
  return {
    status,
    message: isNonEmptyString(outcome?.message) ? outcome.message.trim().slice(0, 500) : 'Local execution failed',
    balanceRaw: finiteNumber(outcome?.balanceRaw),
    rewardRaw: finiteNumber(outcome?.rewardRaw),
  }
}
