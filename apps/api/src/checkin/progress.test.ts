import { describe, expect, it, vi } from 'vitest'
import type { EventBus } from './events.js'
import { RunProgressLog } from './progress.js'

describe('RunProgressLog', () => {
  it('stores entries per run and broadcasts them as run_progress events', () => {
    const emit = vi.fn()
    const log = new RunProgressLog({ emit } as unknown as EventBus)

    log.add({ runId: 7, message: '开始处理 2 个站点' })
    log.add({ runId: 7, siteId: 3, siteName: '示例站', operation: 'checkin', message: '正在签到：示例站' })
    log.add({ runId: 8, siteId: 4, siteName: '余额站', operation: 'balance_refresh', message: '正在刷新余额：余额站' })

    expect(log.list(7).map((entry) => entry.message)).toEqual([
      '开始处理 2 个站点',
      '正在签到：示例站',
    ])
    expect(log.list(8)).toHaveLength(1)
    expect(log.list(99)).toEqual([])
    expect(emit).toHaveBeenCalledTimes(3)
    expect(emit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'run_progress',
      data: expect.objectContaining({
        runId: 7,
        entry: expect.objectContaining({ siteId: 3, siteName: '示例站', operation: 'checkin' }),
      }),
    }))
  })
})
