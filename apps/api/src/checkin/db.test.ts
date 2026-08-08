import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './db.js'

const databases: AppDatabase[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe('check-in site deletion', () => {
  it('removes site-owned records and keeps the channel association target intact', () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('测试站点', 'https://example.com')
    const otherSite = database.createSite('其他站点', 'https://other.example')
    const run = database.startRun('manual')
    const now = new Date().toISOString()

    database.applyResult(site.id, {
      runId: run.id,
      siteId: site.id,
      status: 'failed',
      rewardRaw: null,
      rewardAmount: null,
      balanceBeforeRaw: null,
      balanceBeforeAmount: null,
      balanceAfterRaw: null,
      balanceAfterAmount: null,
      balanceDeltaAmount: null,
      message: 'test',
      startedAt: now,
      completedAt: now,
    })
    database.startAuthSync(site.id, 'assistant', '等待授权')
    database.linkChannel(site.id, '00000000-0000-4000-8000-000000000001')
    database.saveSiteAuthSnapshot(site.id, 'encrypted')

    expect(database.deleteSite(site.id)).toBe(true)
    expect(database.getSite(site.id)).toBeNull()
    expect(database.listResults({ siteId: site.id })).toEqual([])
    expect(database.listAuthSyncEvents(site.id)).toEqual([])
    expect(database.listChannelLinks(site.id)).toEqual([])
    expect(database.getSiteAuthSnapshot(site.id)).toBeNull()
    expect(database.listSiteDeletionLogs()).toMatchObject([{
      siteId: site.id,
      siteName: site.name,
      baseUrl: site.baseUrl,
      message: '站点已删除',
    }])
    expect(database.getSite(otherSite.id)).not.toBeNull()
    expect(database.deleteSite(site.id)).toBe(false)
  })
})

describe('check-in site balance updates', () => {
  it('persists a legitimate zero balance instead of retaining the previous value', () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('余额测试站', 'https://balance.example')

    database.updateSiteAuth(site.id, {
      adapter: 'sub2api',
      authStatus: 'valid',
      lastBalanceRaw: 12.5,
      lastBalanceAmount: 12.5,
    })
    database.updateSiteAuth(site.id, {
      adapter: 'sub2api',
      authStatus: 'valid',
      lastBalanceRaw: 0,
      lastBalanceAmount: 0,
    })

    expect(database.getSite(site.id)).toMatchObject({ lastBalanceRaw: 0, lastBalanceAmount: 0 })
  })

  it('keeps balance-only mode until the site Base URL changes', () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('余额站点', 'https://balance.example')

    database.updateSiteCheckinMode(site.id, 'balance_only')
    expect(database.getSite(site.id)).toMatchObject({ checkinMode: 'balance_only' })

    database.updateSite(site.id, { name: '余额站点新名称' })
    expect(database.getSite(site.id)).toMatchObject({ checkinMode: 'balance_only' })

    database.updateSite(site.id, { baseUrl: 'https://new-balance.example' })
    expect(database.getSite(site.id)).toMatchObject({ checkinMode: 'checkin' })
  })

  it('switches the site type directly and keeps it across later edits', () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('中转站', 'https://relay.example')

    expect(database.updateSite(site.id, { checkinMode: 'balance_only' })).toMatchObject({ checkinMode: 'balance_only' })
    expect(database.updateSite(site.id, { name: '中转站新名称' })).toMatchObject({ checkinMode: 'balance_only' })
    expect(database.updateSite(site.id, { checkinMode: 'checkin' })).toMatchObject({ checkinMode: 'checkin' })
    expect(database.updateSite(site.id, { baseUrl: 'https://new-welfare.example', checkinMode: 'balance_only' })).toMatchObject({ checkinMode: 'balance_only' })
  })

  it('resets stale disabled status when switching back to check-in mode', () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('回切站点', 'https://switch.example')
    const run = database.startRun('manual')
    const now = new Date().toISOString()
    database.applyResult(site.id, {
      runId: run.id,
      siteId: site.id,
      status: 'disabled',
      rewardRaw: null,
      rewardAmount: null,
      balanceBeforeRaw: null,
      balanceBeforeAmount: null,
      balanceAfterRaw: null,
      balanceAfterAmount: null,
      balanceDeltaAmount: null,
      message: '站点未开放签到',
      startedAt: now,
      completedAt: now,
    })
    database.updateSite(site.id, { checkinMode: 'balance_only' })

    expect(database.getSite(site.id)).toMatchObject({ checkinMode: 'balance_only', lastStatus: 'disabled' })
    expect(database.updateSite(site.id, { checkinMode: 'checkin' })).toMatchObject({ checkinMode: 'checkin', lastStatus: 'never' })
  })
})
