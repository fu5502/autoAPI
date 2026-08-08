export const AUTO_AUTH_RETRY_ALARM_PREFIX = 'autoapi-auto-auth-retry:'

export function retryAlarmName(pairId) {
  return `${AUTO_AUTH_RETRY_ALARM_PREFIX}${pairId}`
}

export function retryPairIdFromAlarm(alarmName) {
  if (typeof alarmName !== 'string' || !alarmName.startsWith(AUTO_AUTH_RETRY_ALARM_PREFIX)) return null
  const pairId = alarmName.slice(AUTO_AUTH_RETRY_ALARM_PREFIX.length)
  return pairId || null
}

export function createAutoSyncRetryScheduler({ alarms, run, now = () => Date.now(), setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
  const timers = new Map()
  const inFlight = new Map()

  const clearAlarm = async (pairId) => {
    await Promise.resolve(alarms.clear(retryAlarmName(pairId))).catch(() => undefined)
  }

  const trigger = (pairId) => {
    const existing = inFlight.get(pairId)
    if (existing) return existing
    const work = (async () => {
      const timer = timers.get(pairId)
      if (timer) clearTimeoutFn(timer)
      timers.delete(pairId)
      await clearAlarm(pairId)
      await run(pairId)
    })()
    inFlight.set(pairId, work)
    const clearInFlight = () => {
      if (inFlight.get(pairId) === work) inFlight.delete(pairId)
    }
    void work.then(clearInFlight, clearInFlight)
    return work
  }

  return {
    schedule(pairId, delayMs = 3_000) {
      if (timers.has(pairId)) return
      const delay = Math.max(1_000, Number(delayMs) || 0)
      const timer = setTimeoutFn(() => { void trigger(pairId) }, delay)
      timers.set(pairId, timer)
      void Promise.resolve(alarms.create(retryAlarmName(pairId), { when: now() + delay })).catch(() => undefined)
    },
    async clear(pairId) {
      const timer = timers.get(pairId)
      if (timer) clearTimeoutFn(timer)
      timers.delete(pairId)
      await clearAlarm(pairId)
    },
    async handleAlarm(alarm) {
      const pairId = retryPairIdFromAlarm(alarm?.name)
      if (pairId) await trigger(pairId)
    },
  }
}
