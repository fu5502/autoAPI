import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractHybgzsBalanceRaw,
  extractHybgzsRewardRaw,
  hasVerifiedHybgzsUser,
  normalizeLocalExecutionOutcome,
  validateLocalExecutionClaim,
  validateLocalExecutionStart,
  validateTrustedLocalExecutionOrigin,
} from './local-execution.mjs'

test('only accepts a fixed cdk.hybgzs.com local execution request', () => {
  const request = validateLocalExecutionStart({
    requestId: 'request-1',
    code: ' local-code ',
    siteUrl: 'https://cdk.hybgzs.com/gas-station/checkin',
    operation: 'checkin',
  })

  assert.deepEqual(request, { requestId: 'request-1', code: 'LOCAL-CODE', operation: 'checkin' })
  assert.throws(() => validateLocalExecutionStart({
    requestId: 'request-2',
    code: 'local-code',
    siteUrl: 'https://other.cdk.hybgzs.com/',
    operation: 'checkin',
  }), /only available/)
  assert.throws(() => validateLocalExecutionStart({
    requestId: 'request-http',
    code: 'local-code',
    siteUrl: 'http://cdk.hybgzs.com/',
    operation: 'checkin',
  }), /only available/)
  assert.throws(() => validateLocalExecutionStart({
    requestId: 'request-3',
    code: 'local-code',
    siteUrl: 'https://cdk.hybgzs.com/',
    operation: 'run-script',
  }), /operation is invalid/)
})

test('rejects a claim that changes the host, operation, or expiry', () => {
  const valid = {
    executionId: 'execution-1',
    resultToken: 'result-token',
    domain: 'cdk.hybgzs.com',
    siteUrl: 'https://cdk.hybgzs.com/',
    operation: 'balance_refresh',
    expiresAt: '2026-08-08T12:10:00.000Z',
  }

  assert.deepEqual(validateLocalExecutionClaim(valid, 'balance_refresh', Date.parse('2026-08-08T12:00:00.000Z')), {
    executionId: 'execution-1',
    resultToken: 'result-token',
    operation: 'balance_refresh',
    expiresAt: '2026-08-08T12:10:00.000Z',
  })
  assert.throws(() => validateLocalExecutionClaim({ ...valid, domain: 'evil.example' }, 'balance_refresh'), /unsupported host/)
  assert.throws(() => validateLocalExecutionClaim({ ...valid, operation: 'checkin' }, 'balance_refresh'), /does not match/)
  assert.throws(() => validateLocalExecutionClaim({ ...valid, expiresAt: '2026-08-08T11:59:59.000Z' }, 'balance_refresh', Date.parse('2026-08-08T12:00:00.000Z')), /expired/)
})

test('requires the message and actual tab to match a configured autoAPI origin', () => {
  assert.equal(validateTrustedLocalExecutionOrigin({
    messageOrigin: 'https://autoapi.example.com',
    senderTabUrl: 'https://autoapi.example.com/checkin',
    trustedOrigin: 'https://autoapi.example.com/',
  }), 'https://autoapi.example.com')
  assert.throws(() => validateTrustedLocalExecutionOrigin({
    messageOrigin: 'https://evil.example',
    senderTabUrl: 'https://evil.example/checkin',
    trustedOrigin: 'https://autoapi.example.com',
  }), /configured autoAPI origin/)
  assert.throws(() => validateTrustedLocalExecutionOrigin({
    messageOrigin: 'https://autoapi.example.com',
    senderTabUrl: 'https://evil.example/checkin',
    trustedOrigin: 'https://autoapi.example.com',
  }), /configured autoAPI origin/)
  assert.throws(() => validateTrustedLocalExecutionOrigin({
    messageOrigin: 'https://autoapi.example.com',
    senderTabUrl: 'https://autoapi.example.com/checkin',
    trustedOrigin: '',
  }), /Configure this autoAPI origin/)
})

test('extracts raw values only from a verified user response', () => {
  const user = { success: true, data: { user: { id: 'user-42' } } }
  const anonymous = { success: true, data: { user: { id: 0 } } }
  const wallet = { success: true, data: { total: 750_000, wallet: { balance: 1 }, mainSite: { balance: 1_298_180_000 } } }
  const mainSite = { success: true, data: { balance: 1_298_180_000, connected: true } }
  const walletOnly = { success: true, data: { total: 750_000, wallet: { balance: 1 } } }
  const config = { success: true, data: { todayCheckinInfo: { rewardQuota: 250_000 } } }

  assert.equal(hasVerifiedHybgzsUser(user), true)
  assert.equal(hasVerifiedHybgzsUser(anonymous), false)
  assert.equal(extractHybgzsBalanceRaw(wallet), 1_298_180_000)
  assert.equal(extractHybgzsBalanceRaw(mainSite), 1_298_180_000)
  assert.equal(extractHybgzsBalanceRaw(walletOnly), 750_000)
  assert.equal(extractHybgzsRewardRaw(config), 250_000)
  assert.equal(extractHybgzsBalanceRaw({ success: true, data: { total: '750000' } }), null)
})

test('normalizes a local execution outcome into the report contract', () => {
  assert.deepEqual(normalizeLocalExecutionOutcome({
    status: 'success',
    message: ' Balance refreshed ',
    balanceRaw: 500_000,
    rewardRaw: Number.NaN,
  }), {
    status: 'success',
    message: 'Balance refreshed',
    balanceRaw: 500_000,
    rewardRaw: null,
  })
  assert.deepEqual(normalizeLocalExecutionOutcome({ status: 'unknown' }), {
    status: 'failed',
    message: 'Local execution failed',
    balanceRaw: null,
    rewardRaw: null,
  })
})
