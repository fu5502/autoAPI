import { createCipheriv, createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import type { OpsAgent } from '../agent/ops-agent.js'
import { createSecretBox } from '../security/secret-box.js'
import { AppDatabase } from './db.js'
import { CookieCloudService, decryptCookieCloud } from './cookiecloud.js'
import { EventBus } from './events.js'
import { registerCheckinRoutes, type CheckinModule } from './module.js'
import { registerCompressedJsonParser } from '../http/compressed-json.js'

const databases: AppDatabase[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function makeService() {
  const database = new AppDatabase(':memory:')
  databases.push(database)
  const secrets = createSecretBox('cookiecloud-test-encryption-key')
  return { database, service: new CookieCloudService(database, secrets, new EventBus()), secrets }
}

function encryptCookieCloud(
  payload: unknown,
  uuid: string,
  password: string,
  cryptoType: 'legacy' | 'aes-128-cbc-fixed',
): string {
  const passphrase = createHash('md5').update(`${uuid}-${password}`).digest('hex').slice(0, 16)
  const plaintext = JSON.stringify(payload)
  if (cryptoType === 'aes-128-cbc-fixed') {
    const cipher = createCipheriv('aes-128-cbc', Buffer.from(passphrase, 'utf8'), Buffer.alloc(16))
    return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64')
  }

  const cipher = createCipheriv('aes-256-cbc', deriveLegacyKey(passphrase), deriveLegacyIv(passphrase))
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64')
}

function deriveLegacyKey(passphrase: string): Buffer {
  return evpBytesToKey(Buffer.from(passphrase, 'utf8'), null, 32, 16)[0]
}

function deriveLegacyIv(passphrase: string): Buffer {
  return evpBytesToKey(Buffer.from(passphrase, 'utf8'), null, 32, 16)[1]
}

function evpBytesToKey(password: Buffer, salt: Buffer | null, keyLength: number, ivLength: number): [Buffer, Buffer] {
  const chunks: Buffer[] = []
  let previous = Buffer.alloc(0)
  while (Buffer.concat(chunks).length < keyLength + ivLength) {
    previous = createHash('md5').update(Buffer.concat([previous, password, salt ?? Buffer.alloc(0)])).digest()
    chunks.push(previous)
  }
  const output = Buffer.concat(chunks)
  return [output.subarray(0, keyLength), output.subarray(keyLength, keyLength + ivLength)]
}

describe('CookieCloud compatibility', () => {
  it.each(['legacy', 'aes-128-cbc-fixed'] as const)('decrypts the official %s payload format', (cryptoType) => {
    const payload = {
      cookie_data: {
        'example.com': [{ name: 'session', value: 'cookie-value', domain: '.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax' }],
      },
      local_storage_data: { 'example.com': { access_token: 'storage-token' } },
      update_time: new Date().toISOString(),
    }
    const encrypted = encryptCookieCloud(payload, 'test-uuid', 'test-password', cryptoType)
    expect(decryptCookieCloud(encrypted, 'test-uuid', 'test-password', cryptoType)).toEqual(payload)
  })

  it('accepts a gzipped upload, filters other domains, and stores only encrypted auth state', async () => {
    const { database, service, secrets } = makeService()
    const site = database.createSite('测试站点', 'https://example.com/dashboard')
    const pairing = service.createPair(site)
    const payload = {
      cookie_data: {
        'example.com': [{ name: 'session', value: 'cookie-value', domain: '.example.com', path: '/', secure: true, httpOnly: true }],
        'other.example.net': [{ name: 'should-not-copy', value: 'secret', domain: '.other.example.net', path: '/' }],
      },
      local_storage_data: {
        'example.com': { access_token: 'storage-token' },
        'other.example.net': { ignored: 'value' },
      },
    }
    const encrypted = encryptCookieCloud(payload, pairing.uuid, pairing.password, 'legacy')
    const compressed = gzipSync(JSON.stringify({ uuid: pairing.uuid, encrypted, crypto_type: 'legacy' }))
    const upload = JSON.parse(gunzipSync(compressed).toString('utf8')) as { uuid: string; encrypted: string; crypto_type: 'legacy' }
    expect(upload.uuid).toBe(pairing.uuid)

    const status = service.acceptUpload(upload.uuid, upload.encrypted, pairing.uploadToken, upload.crypto_type)
    expect(status).toMatchObject({ status: 'received', cookieCount: 1, localStorageCount: 1 })

    const snapshot = await service.getSnapshot(site.id)
    expect(snapshot?.cookies).toHaveLength(1)
    expect(snapshot?.cookies[0]?.value).toBe('cookie-value')
    expect(snapshot?.localStorageByHost).toEqual({ 'example.com': { access_token: 'storage-token' } })

    const stored = database.getSiteAuthSnapshot(site.id)
    expect(stored?.encrypted).toBeTruthy()
    expect(stored?.encrypted).not.toContain('cookie-value')
    expect(JSON.parse(secrets.decrypt(stored!.encrypted)).cookies[0].value).toBe('cookie-value')
  })

  it('rejects missing or wrong one-time upload tokens', () => {
    const { database, service } = makeService()
    const site = database.createSite('测试站点', 'https://example.com')
    const pairing = service.createPair(site)
    const encrypted = encryptCookieCloud({ cookie_data: { 'example.com': [{ name: 'session', value: 'ok', domain: '.example.com' }] } }, pairing.uuid, pairing.password, 'legacy')

    expect(() => service.acceptUpload(pairing.uuid, encrypted, 'wrong-token')).toThrow('上传授权码不正确')
    service.acceptUpload(pairing.uuid, encrypted, pairing.uploadToken)
    expect(() => service.acceptUpload(pairing.uuid, encrypted, pairing.uploadToken)).toThrow('配对已结束')
  })

  it('cancels a pairing and does not accept it afterwards', () => {
    const { database, service } = makeService()
    const site = database.createSite('测试站点', 'https://example.com')
    const pairing = service.createPair(site)
    expect(service.cancelPair(pairing.pairId, site.id)).toMatchObject({ status: 'cancelled' })
    expect(() => service.acceptUpload(pairing.uuid, 'ignored', pairing.uploadToken)).toThrow('配对已结束')
  })

  it('accepts the official gzip upload request on the public CookieCloud endpoint', async () => {
    const { database, service } = makeService()
    const site = database.createSite('测试站点', 'https://example.com')
    const pairing = service.createPair(site)
    const encrypted = encryptCookieCloud({ cookie_data: { 'example.com': [{ name: 'session', value: 'ok', domain: '.example.com' }] } }, pairing.uuid, pairing.password, 'legacy')
    const app = Fastify({ logger: false })
    registerCompressedJsonParser(app)
    const module = {
      db: database,
      cookieCloud: service,
      interactiveAuthorizationEnabled: false,
    } as unknown as CheckinModule

    await registerCheckinRoutes(app, module, async () => undefined, { agent: {} as OpsAgent })
    const compressed = gzipSync(JSON.stringify({ uuid: pairing.uuid, encrypted, crypto_type: 'legacy' }))
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const response = await fetch(`${address}/cookiecloud/update`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-autoapi-pairing-token': pairing.uploadToken,
      },
      body: compressed,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ action: 'done', status: { status: 'received' } })
    await app.close()
  })
})
