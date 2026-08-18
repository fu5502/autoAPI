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

  it('records the check-in time when already checked even without a reward', () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('已签到站点', 'https://checked.example')
    const run = database.startRun('manual')
    const completedAt = new Date().toISOString()
    database.applyResult(site.id, {
      runId: run.id,
      siteId: site.id,
      status: 'already_checked',
      rewardRaw: null,
      rewardAmount: null,
      balanceBeforeRaw: null,
      balanceBeforeAmount: null,
      balanceAfterRaw: null,
      balanceAfterAmount: null,
      balanceDeltaAmount: null,
      message: '今日已签到',
      startedAt: completedAt,
      completedAt,
    })

    expect(database.getSite(site.id)).toMatchObject({ lastStatus: 'already_checked', lastRewardAt: completedAt })
  })

  it('does not update balance or reward times when a disabled refresh reads no balance', () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('no-read-site', 'https://no-read.example')
    const firstRun = database.startRun('manual')
    const secondRun = database.startRun('manual')
    const previous = new Date('2026-08-09T08:00:00.000Z').toISOString()
    const today = new Date('2026-08-10T08:00:00.000Z').toISOString()

    database.applyResult(site.id, {
      runId: firstRun.id,
      siteId: site.id,
      status: 'success',
      rewardRaw: 5,
      rewardAmount: 5,
      balanceBeforeRaw: 10,
      balanceBeforeAmount: 10,
      balanceAfterRaw: 10,
      balanceAfterAmount: 10,
      balanceDeltaAmount: 0,
      balanceUpdated: true,
      message: 'checkin success',
      startedAt: previous,
      completedAt: previous,
    })
    const before = database.getSite(site.id)!
    expect(before.lastBalanceRefreshSuccess).toBe(true)

    database.applyResult(site.id, {
      runId: secondRun.id,
      siteId: site.id,
      status: 'disabled',
      rewardRaw: null,
      rewardAmount: null,
      balanceBeforeRaw: 10,
      balanceBeforeAmount: 10,
      balanceAfterRaw: 10,
      balanceAfterAmount: 10,
      balanceDeltaAmount: 0,
      balanceUpdated: false,
      message: '自动签到已关闭，未读取到最新余额',
      startedAt: today,
      completedAt: today,
    })

    const after = database.getSite(site.id)!
    expect(after.lastBalanceUpdatedAt).toBe(before.lastBalanceUpdatedAt)
    expect(after.lastRewardAt).toBe(before.lastRewardAt)
    expect(after.lastBalanceRefreshSuccess).toBe(false)
  })

  it('keeps the last check-in status when a balance refresh returns disabled', () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('签到保留站', 'https://preserve.example')
    const firstRun = database.startRun('manual')
    const secondRun = database.startRun('manual')
    const completedAt = new Date().toISOString()
    database.applyResult(site.id, {
      runId: firstRun.id,
      siteId: site.id,
      status: 'success',
      rewardRaw: 5,
      rewardAmount: 5,
      balanceBeforeRaw: null,
      balanceBeforeAmount: null,
      balanceAfterRaw: null,
      balanceAfterAmount: null,
      balanceDeltaAmount: null,
      message: '签到成功',
      startedAt: completedAt,
      completedAt,
    })
    database.applyResult(site.id, {
      runId: secondRun.id,
      siteId: site.id,
      status: 'disabled',
      rewardRaw: null,
      rewardAmount: null,
      balanceBeforeRaw: null,
      balanceBeforeAmount: null,
      balanceAfterRaw: 10,
      balanceAfterAmount: 10,
      balanceDeltaAmount: null,
      message: '自动签到已关闭，余额已刷新',
      startedAt: completedAt,
      completedAt,
    }, { preserveLastStatus: true })

    expect(database.getSite(site.id)).toMatchObject({ lastStatus: 'success', lastRewardAmount: 5 })
  })

  it('clears a running marker when a balance refresh finishes as disabled', () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('中转站', 'https://relay.example')
    const run = database.startRun('manual')
    const completedAt = new Date().toISOString()

    database.markSiteRunning(site.id)
    database.applyResult(site.id, {
      runId: run.id,
      siteId: site.id,
      status: 'disabled',
      rewardRaw: null,
      rewardAmount: null,
      balanceBeforeRaw: null,
      balanceBeforeAmount: null,
      balanceAfterRaw: 10,
      balanceAfterAmount: 10,
      balanceDeltaAmount: null,
      message: '自动签到已关闭，余额已刷新',
      startedAt: completedAt,
      completedAt,
    }, { preserveLastStatus: true })

    expect(database.getSite(site.id)).toMatchObject({ lastStatus: 'disabled', lastBalanceAmount: 10 })
  })
})

describe('check-in site reorder', () => {
  it('appends new sites after existing ones and persists a manual order', () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const a = database.createSite('A', 'https://a.example')
    const b = database.createSite('B', 'https://b.example')
    const c = database.createSite('C', 'https://c.example')

    // New sites come back in creation order (sort_order ascending, id ascending
    // as the tiebreaker while all defaults are 0).
    expect(database.listSites().map((site) => site.id)).toEqual([a.id, b.id, c.id])

    // Reverse the order of a single group; only those ids are renumbered.
    database.reorderSites([c.id, a.id, b.id])
    expect(database.listSites().map((site) => site.id)).toEqual([c.id, a.id, b.id])
  })

  it('keeps the two management groups independently ordered', () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const w1 = database.createSite('公益1', 'https://w1.example')
    const w2 = database.createSite('公益2', 'https://w2.example')
    const r1 = database.createSite('中转1', 'https://r1.example', '', null, 'balance_only')
    const r2 = database.createSite('中转2', 'https://r2.example', '', null, 'balance_only')

    // Reorder only the welfare group; relay keeps its creation order.
    database.reorderSites([w2.id, w1.id])
    const sites = database.listSites()
    const welfare = sites.filter((site) => site.checkinMode === 'checkin').map((site) => site.id)
    const relay = sites.filter((site) => site.checkinMode === 'balance_only').map((site) => site.id)
    expect(welfare).toEqual([w2.id, w1.id])
    expect(relay).toEqual([r1.id, r2.id])
  })
})
