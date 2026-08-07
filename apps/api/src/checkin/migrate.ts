import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AppDatabase } from './db.js'
import { dataRoot } from './config.js'

const defaultSourceRoot = path.join(os.homedir(), 'Desktop', 'zhongzhuanzhan', 'data')

interface Options {
  sourceRoot: string
  targetRoot: string
  backupOnly: boolean
}

export function parseOptions(): Options {
  const args = process.argv.slice(2)
  const valueAfter = (name: string) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  return {
    sourceRoot: path.resolve(valueAfter('--source') ?? process.env.CHECKIN_MIGRATION_SOURCE ?? defaultSourceRoot),
    targetRoot: path.resolve(valueAfter('--target') ?? dataRoot),
    backupOnly: args.includes('--backup'),
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function count(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdentifier(table)}`).get() as { n?: unknown } | undefined
  return Number(row?.n ?? 0)
}

export function copyMissing(source: string, target: string): number {
  if (!fs.existsSync(source)) return 0
  fs.mkdirSync(target, { recursive: true })
  let copied = 0
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name)
    const targetPath = path.join(target, entry.name)
    if (entry.isDirectory()) {
      copied += copyMissing(sourcePath, targetPath)
    } else if (!fs.existsSync(targetPath)) {
      try {
        fs.copyFileSync(sourcePath, targetPath)
        copied += 1
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EBUSY')) throw error
      }
    }
  }
  return copied
}

export function backupTarget(targetRoot: string): string | null {
  if (!fs.existsSync(targetRoot)) return null
  const parent = path.join(path.dirname(targetRoot), 'checkin-backups')
  const name = `checkin-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')}`
  const target = path.join(parent, name)
  fs.mkdirSync(parent, { recursive: true })
  fs.cpSync(targetRoot, target, { recursive: true, errorOnExist: true })
  return target
}

function ensureTargetSchema(targetPath: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  const database = new AppDatabase(targetPath)
  database.close()
}

export function migrateDatabase(sourcePath: string, targetPath: string): { source: { sites: number; runs: number; results: number; settings: number; icons: number }; sites: number; runs: number; results: number; settings: number; icons: number } {
  ensureTargetSchema(targetPath)
  const database = new DatabaseSync(targetPath)
  database.exec(`ATTACH DATABASE ${quoteLiteral(sourcePath)} AS source`)
  database.exec('PRAGMA foreign_keys = ON;')
  const sourceCounts = {
    sites: countAttached(database, 'sites'),
    runs: countAttached(database, 'checkin_runs'),
    results: countAttached(database, 'checkin_results'),
    settings: countAttached(database, 'settings'),
    icons: countAttached(database, 'site_icon_assets'),
  }

  const before = {
    sites: count(database, 'sites'),
    runs: count(database, 'checkin_runs'),
    results: count(database, 'checkin_results'),
    settings: count(database, 'settings'),
    icons: count(database, 'site_icon_assets'),
  }

  database.exec('BEGIN')
  try {
    database.exec(`
      INSERT INTO sites (
        name, base_url, note, favicon_url, favicon_custom, adapter, enabled, auth_status,
        username, legacy_user_id, currency_symbol, quota_per_unit, display_scale,
        last_balance_raw, last_balance_amount, last_balance_updated_at, last_checked_at, last_status, last_reward_amount,
        last_reward_at, last_balance_delta_amount, last_error, created_at, updated_at
      )
      SELECT name, base_url, note, favicon_url, favicon_custom, adapter, enabled, auth_status,
        username, legacy_user_id, currency_symbol, quota_per_unit, display_scale,
        last_balance_raw, last_balance_amount, last_checked_at, last_checked_at, last_status, last_reward_amount,
        last_reward_at, last_balance_delta_amount, last_error, created_at, updated_at
      FROM source.sites AS source_sites
      WHERE NOT EXISTS (SELECT 1 FROM sites AS target_sites WHERE target_sites.base_url = source_sites.base_url)
    `)

    database.exec(`
      INSERT INTO settings (key, value)
      SELECT key, value FROM source.settings
      WHERE NOT EXISTS (SELECT 1 FROM settings AS target_settings WHERE target_settings.key = source.settings.key)
    `)

    database.exec(`
      INSERT INTO checkin_runs (trigger, status, started_at, completed_at, success_count, failed_count, skipped_count)
      SELECT source_runs.trigger, source_runs.status, source_runs.started_at, source_runs.completed_at,
        source_runs.success_count, source_runs.failed_count, source_runs.skipped_count
      FROM source.checkin_runs AS source_runs
      WHERE NOT EXISTS (
        SELECT 1 FROM checkin_runs AS target_runs
        WHERE target_runs.trigger = source_runs.trigger AND target_runs.started_at = source_runs.started_at
      )
    `)

    database.exec(`
      INSERT INTO checkin_results (
        run_id, site_id, site_name, status, reward_raw, reward_amount, balance_before_raw,
        balance_before_amount, balance_after_raw, balance_after_amount, balance_delta_amount,
        message, started_at, completed_at
      )
      SELECT target_runs.id, target_sites.id, source_results.site_name, source_results.status,
        source_results.reward_raw, source_results.reward_amount, source_results.balance_before_raw,
        source_results.balance_before_amount, source_results.balance_after_raw, source_results.balance_after_amount,
        source_results.balance_delta_amount, source_results.message, source_results.started_at, source_results.completed_at
      FROM source.checkin_results AS source_results
      JOIN source.checkin_runs AS source_runs ON source_runs.id = source_results.run_id
      JOIN source.sites AS source_sites ON source_sites.id = source_results.site_id
      JOIN checkin_runs AS target_runs ON target_runs.trigger = source_runs.trigger AND target_runs.started_at = source_runs.started_at
      JOIN sites AS target_sites ON target_sites.base_url = source_sites.base_url
      WHERE NOT EXISTS (
        SELECT 1 FROM checkin_results AS target_results
        WHERE target_results.run_id = target_runs.id AND target_results.site_id = target_sites.id
          AND target_results.started_at = source_results.started_at AND target_results.completed_at = source_results.completed_at
          AND target_results.status = source_results.status AND target_results.message = source_results.message
      )
    `)

    database.exec(`
      INSERT INTO site_icon_assets (site_id, url, content_type, body, updated_at)
      SELECT target_sites.id, source_icons.url, source_icons.content_type, source_icons.body, source_icons.updated_at
      FROM source.site_icon_assets AS source_icons
      JOIN source.sites AS source_sites ON source_sites.id = source_icons.site_id
      JOIN sites AS target_sites ON target_sites.base_url = source_sites.base_url
      WHERE NOT EXISTS (SELECT 1 FROM site_icon_assets AS target_icons WHERE target_icons.site_id = target_sites.id)
    `)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  } finally {
    database.close()
  }

  const reopened = new DatabaseSync(targetPath, { readOnly: true })
  const after = {
    sites: count(reopened, 'sites'),
    runs: count(reopened, 'checkin_runs'),
    results: count(reopened, 'checkin_results'),
    settings: count(reopened, 'settings'),
    icons: count(reopened, 'site_icon_assets'),
  }
  reopened.close()
  return {
    source: sourceCounts,
    sites: after.sites - before.sites,
    runs: after.runs - before.runs,
    results: after.results - before.results,
    settings: after.settings - before.settings,
    icons: after.icons - before.icons,
  }
}

function countAttached(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS n FROM source.${quoteIdentifier(table)}`).get() as { n?: unknown } | undefined
  return Number(row?.n ?? 0)
}

export function main() {
  const options = parseOptions()
  if (path.resolve(options.sourceRoot) === path.resolve(options.targetRoot)) {
    throw new Error('签到迁移源目录和目标目录不能相同')
  }
  fs.mkdirSync(options.targetRoot, { recursive: true })
  const backup = backupTarget(options.targetRoot)
  if (options.backupOnly) {
    console.log(JSON.stringify({ ok: true, backup }, null, 2))
    return
  }

  const sourcePath = path.join(options.sourceRoot, 'checkin.sqlite')
  if (!fs.existsSync(sourcePath)) throw new Error(`未找到源 SQLite：${sourcePath}`)
  const targetPath = path.join(options.targetRoot, 'checkin.sqlite')
  const result = migrateDatabase(sourcePath, targetPath)
  const copiedBrowserFiles = copyMissing(path.join(options.sourceRoot, 'browser-profile'), path.join(options.targetRoot, 'browser-profile'))
  console.log(JSON.stringify({ ok: true, sourcePath, targetPath, backup, copiedBrowserFiles, migrated: result }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
