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
