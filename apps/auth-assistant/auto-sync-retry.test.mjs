import test from 'node:test'
import assert from 'node:assert/strict'
import { createAutoSyncRetryScheduler, retryAlarmName } from './auto-sync-retry.mjs'

test('persists automatic authorization retries as Chrome alarms', async () => {
  const created = []
  const cleared = []
  const executed = []
  let scheduledCallback
  const scheduler = createAutoSyncRetryScheduler({
    alarms: {
      create: (name, options) => { created.push({ name, options }) },
      clear: async (name) => { cleared.push(name); return true },
    },
    run: async (pairId) => { executed.push(pairId) },
    now: () => 1_000,
    setTimeoutFn: (callback, delay) => {
      scheduledCallback = callback
      return { delay }
    },
    clearTimeoutFn: () => undefined,
  })

  scheduler.schedule('pair-1', 900)

  assert.deepEqual(created, [{ name: retryAlarmName('pair-1'), options: { when: 2_000 } }])
  scheduledCallback()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(executed, ['pair-1'])
  assert.deepEqual(cleared, [retryAlarmName('pair-1')])
})

test('an alarm resumes a retry after the service worker has restarted', async () => {
  const executed = []
  const scheduler = createAutoSyncRetryScheduler({
    alarms: {
      create: () => undefined,
      clear: async () => true,
    },
    run: async (pairId) => { executed.push(pairId) },
  })

  await scheduler.handleAlarm({ name: retryAlarmName('pair-after-restart') })

  assert.deepEqual(executed, ['pair-after-restart'])
})

test('runs one retry when the timer and alarm fire together', async () => {
  let scheduledCallback
  let releaseRun
  let runCount = 0
  const runFinished = new Promise((resolve) => { releaseRun = resolve })
  const scheduler = createAutoSyncRetryScheduler({
    alarms: {
      create: () => undefined,
      clear: async () => true,
    },
    run: async () => {
      runCount += 1
      await runFinished
    },
    setTimeoutFn: (callback) => {
      scheduledCallback = callback
      return {}
    },
    clearTimeoutFn: () => undefined,
  })

  scheduler.schedule('pair-race')
  scheduledCallback()
  await new Promise((resolve) => setImmediate(resolve))
  const alarmRun = scheduler.handleAlarm({ name: retryAlarmName('pair-race') })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(runCount, 1)
  releaseRun()
  await alarmRun
})
