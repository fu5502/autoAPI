import { createCipheriv, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createSecretBox } from '../security/secret-box.js'
import { AuthAssistantService } from './auth-assistant.js'
import { AppDatabase } from './db.js'
import { EventBus } from './events.js'

const databases: AppDatabase[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function makeService() {
  const database = new AppDatabase(':memory:')
  databases.push(database)
  const service = new AuthAssistantService(database, createSecretBox('auth-assistant-test-key'), new EventBus())
  return { database, service }
}

function encryptPayload(payload: unknown, secret: string) {
  const key = fromBase64Url(secret)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final(), cipher.getAuthTag()])
  return { iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext) }
}

function fromBase64Url(value: string) {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4), 'base64')
}

function toBase64Url(value: Uint8Array) {
  return Buffer.from(value).toString('base64url')
}

describe('autoAPI authorization assistant', () => {
  it('claims a code, stores encrypted browser state, and records success', async () => {
    const { database, service } = makeService()
    const site = database.createSite('我的自定义站点名称', 'https://cdk.hybgzs.com/dashboard')
    const pairing = service.createPair(site)
    const claim = service.claim(pairing.code)
    const encrypted = encryptPayload({
      siteOrigin: 'https://cdk.hybgzs.com',
      pageTitle: '  黑与白福利站\n控制台  ',
      cookies: [{ name: 'session', value: 'secret-cookie', domain: '.hybgzs.com', path: '/', secure: true, httpOnly: true }],
      localStorage: { access_token: 'secret-storage' },
    }, claim.secret)

    const status = service.acceptUpload({ pairId: claim.pairId, uploadToken: claim.uploadToken, ...encrypted })

    expect(status).toMatchObject({ status: 'received', cookieCount: 1, localStorageCount: 1 })
    expect(database.getSite(site.id)).toMatchObject({ name: '黑与白福利站 控制台', authStatus: 'valid', authSyncStatus: 'success' })
    expect(database.listAuthSyncEvents(site.id)[0]).toMatchObject({ status: 'success', cookieCount: 1, localStorageCount: 1 })
    const stored = database.getSiteAuthSnapshot(site.id)
    expect(stored?.encrypted).toBeTruthy()
    expect(stored?.encrypted).not.toContain('secret-cookie')
  })

  it('rejects a page from another origin and records the failure', () => {
    const { database, service } = makeService()
    const site = database.createSite('测试站点', 'https://example.com')
    const pairing = service.createPair(site)
    const claim = service.claim(pairing.code)
    const encrypted = encryptPayload({
      siteOrigin: 'https://evil.invalid',
      cookies: [{ name: 'session', value: 'ignored', domain: '.evil.invalid', path: '/' }],
    }, claim.secret)

    expect(() => service.acceptUpload({ pairId: claim.pairId, uploadToken: claim.uploadToken, ...encrypted })).toThrow('不是目标签到站点')
    expect(database.listAuthSyncEvents(site.id)[0]).toMatchObject({ status: 'failed' })
  })

  it('accepts an authorized subdomain and keeps local storage bound to that origin', async () => {
    const { database, service } = makeService()
    const site = database.createSite('测试站点', 'https://example.com')
    const pairing = service.createPair(site)
    const claim = service.claim(pairing.code, 'app.example.com')
    const encrypted = encryptPayload({
      siteOrigin: 'https://app.example.com',
      cookies: [{ name: 'session', value: 'subdomain-cookie', domain: 'app.example.com', path: '/', secure: true }],
      localStorage: { access_token: 'subdomain-storage' },
    }, claim.secret)

    const status = service.acceptUpload({ pairId: claim.pairId, uploadToken: claim.uploadToken, ...encrypted })
    const snapshot = await service.getSnapshot(site.id)

    expect(status).toMatchObject({ status: 'received', cookieCount: 1, localStorageCount: 1 })
    expect(snapshot).toMatchObject({
      siteOrigin: 'https://app.example.com',
      localStorageByHost: { 'app.example.com': { access_token: 'subdomain-storage' } },
    })
  })

  it('rejects a wrong token and prevents replay after success', () => {
    const { database, service } = makeService()
    const site = database.createSite('测试站点', 'https://example.com')
    const pairing = service.createPair(site)
    const claim = service.claim(pairing.code)
    const encrypted = encryptPayload({
      siteOrigin: 'https://example.com',
      cookies: [{ name: 'session', value: 'ok', domain: '.example.com', path: '/' }],
    }, claim.secret)
    const input = { pairId: claim.pairId, uploadToken: claim.uploadToken, ...encrypted }

    expect(() => service.acceptUpload({ ...input, uploadToken: 'wrong-token' })).toThrow('Token 不正确')
    service.acceptUpload(input)
    expect(() => service.acceptUpload(input)).toThrow('授权任务已结束')
    expect(database.listAuthSyncEvents(site.id)).toHaveLength(1)
  })

  it('records a failure reported by the assistant and invalidates the upload token', () => {
    const { database, service } = makeService()
    const site = database.createSite('测试站点', 'https://example.com')
    const pairing = service.createPair(site)
    const claim = service.claim(pairing.code, 'example.com')

    const status = service.failPair({
      pairId: claim.pairId,
      uploadToken: claim.uploadToken,
      message: '读取当前页面失败',
    })

    expect(status).toMatchObject({ status: 'failed', message: '读取当前页面失败' })
    expect(database.listAuthSyncEvents(site.id)[0]).toMatchObject({
      status: 'failed',
      message: '读取当前页面失败',
    })
    expect(() => service.failPair({
      pairId: claim.pairId,
      uploadToken: claim.uploadToken,
      message: '重复上报',
    })).toThrow('授权任务已结束')
  })

  it('checks the active hostname before consuming a one-time authorization code', () => {
    const { database, service } = makeService()
    const site = database.createSite('测试站点', 'https://example.com')
    const pairing = service.createPair(site)

    expect(() => service.claim(pairing.code, 'evil.example')).toThrow('不匹配')
    expect(service.claim(pairing.code, 'app.example.com')).toMatchObject({ pairId: pairing.pairId })
    expect(() => service.claim(pairing.code, 'app.example.com')).toThrow('授权任务已结束')
  })

  it('previews the target site without consuming the authorization code', () => {
    const { database, service } = makeService()
    const site = database.createSite('目标站点', 'https://elysir.h-e.top/dashboard')
    const pairing = service.createPair(site)

    expect(service.preview(pairing.code)).toMatchObject({
      pairId: pairing.pairId,
      siteName: '目标站点',
      domain: 'elysir.h-e.top',
      siteUrl: 'https://elysir.h-e.top/dashboard',
    })
    expect(service.claim(pairing.code, 'elysir.h-e.top')).toMatchObject({ pairId: pairing.pairId })
  })

  it('marks in-flight authorization records as failed after a service restart', () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('测试站点', 'https://example.com')
    database.startAuthSync(site.id, 'assistant', '等待授权')

    const service = new AuthAssistantService(database, createSecretBox('auth-assistant-test-key'), new EventBus())
    expect(service).toBeTruthy()
    expect(database.listAuthSyncEvents(site.id)[0]).toMatchObject({ status: 'failed', message: '服务已重启，本次授权任务已失效，请重新生成授权码' })
  })
})
