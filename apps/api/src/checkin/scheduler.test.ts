import { describe, expect, it } from 'vitest'
import { chooseNextRun } from './scheduler.js'

describe('check-in daily scheduler', () => {
  it('uses the configured Asia/Shanghai wall clock regardless of the process timezone', () => {
    const beforeWindow = new Date('2026-08-06T23:30:00.000Z') // 07:30 in Shanghai
    expect(chooseNextRun(beforeWindow, '08:00', '10:00', () => 0).toISOString())
      .toBe('2026-08-07T00:00:00.000Z')

    const afterWindow = new Date('2026-08-07T02:30:00.000Z') // 10:30 in Shanghai
    expect(chooseNextRun(afterWindow, '08:00', '10:00', () => 0).toISOString())
      .toBe('2026-08-08T00:00:00.000Z')
  })

  it('moves to the next Shanghai day after a scheduled run already occurred today', () => {
    const now = new Date('2026-08-07T01:00:00.000Z')
    const lastRun = '2026-08-06T23:00:00.000Z'
    expect(chooseNextRun(now, '08:00', '10:00', () => 0, lastRun).toISOString())
      .toBe('2026-08-08T00:00:00.000Z')
  })
})
