import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './db.js'
import { backupTarget, copyMissing, migrateDatabase } from './migrate.js'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('check-in data migration', () => {
  it('is idempotent, backs up the target, copies browser data, and never modifies the source', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoapi-checkin-migrate-'))
    temporaryRoots.push(root)
    const sourceRoot = path.join(root, 'source')
    const targetRoot = path.join(root, 'target')
    const sourceDatabasePath = path.join(sourceRoot, 'checkin.sqlite')
    const targetDatabasePath = path.join(targetRoot, 'checkin.sqlite')
    fs.mkdirSync(sourceRoot, { recursive: true })

    const source = new AppDatabase(sourceDatabasePath)
    const site = source.createSite('迁移测试站', 'https://relay.example.com')
    const run = source.startRun('manual')
    source.applyResult(site.id, {
      runId: run.id,
      siteId: site.id,
      status: 'success',
      rewardRaw: 500_000,
      rewardAmount: 1,
      balanceBeforeRaw: 1_000_000,
      balanceBeforeAmount: 2,
      balanceAfterRaw: 1_500_000,
      balanceAfterAmount: 3,
      balanceDeltaAmount: 1,
      message: '签到成功',
      startedAt: '2026-08-06T00:00:00.000Z',
      completedAt: '2026-08-06T00:00:01.000Z',
      loginVerified: true,
    })
    source.completeRun(run.id, { success: 1, failed: 0, skipped: 0 })
    source.close()

    const browserSource = path.join(sourceRoot, 'browser-profile')
    const browserTarget = path.join(targetRoot, 'browser-profile')
    fs.mkdirSync(browserSource, { recursive: true })
    fs.writeFileSync(path.join(browserSource, 'Cookies'), 'session-cookie', 'utf8')
    const sourceBefore = fs.readFileSync(sourceDatabasePath)

    const first = migrateDatabase(sourceDatabasePath, targetDatabasePath)
    expect(first).toMatchObject({ sites: 1, runs: 1, results: 1 })
    expect(copyMissing(browserSource, browserTarget)).toBe(1)
    expect(fs.readFileSync(path.join(browserTarget, 'Cookies'), 'utf8')).toBe('session-cookie')

    const backup = backupTarget(targetRoot)
    expect(backup).not.toBeNull()
    expect(fs.existsSync(path.join(backup!, 'checkin.sqlite'))).toBe(true)

    const second = migrateDatabase(sourceDatabasePath, targetDatabasePath)
    expect(second).toMatchObject({ sites: 0, runs: 0, results: 0, settings: 0, icons: 0 })
    expect(copyMissing(browserSource, browserTarget)).toBe(0)
    expect(fs.readFileSync(sourceDatabasePath)).toEqual(sourceBefore)

    const target = new AppDatabase(targetDatabasePath)
    expect(target.listSites()).toHaveLength(1)
    expect(target.listResults({ limit: 10 })).toHaveLength(1)
    target.close()
  })
})
