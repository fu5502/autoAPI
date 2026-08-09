import { hasLikelyAuthState } from './auth-state.mjs'
import { createAutoSyncRetryScheduler } from './auto-sync-retry.mjs'
import {
  HYBGZS_LOCAL_EXECUTION_HOST,
  normalizeLocalExecutionOutcome,
  TRUSTED_AUTOAPI_ORIGIN_KEY,
  validateLocalExecutionClaim,
  validateLocalExecutionStart,
  validateTrustedLocalExecutionOrigin,
} from './local-execution.mjs'

const AUTO_AUTH_TASKS_KEY = 'autoapi-auto-auth-tasks'
const queuedSyncs = new Map()
const localExecutionJobs = new Map()
const autoSyncRetryScheduler = createAutoSyncRetryScheduler({
  alarms: chrome.alarms,
  run: async (pairId) => {
    queuedSyncs.delete(pairId)
    await tryAutoSync(pairId)
  },
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'sync') {
    void syncCurrentTab(message).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error?.message || '授权助手执行失败' }))
    return true
  }
  if (message?.type === 'start-auto-auth') {
    void startAutoAuth(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, phase: 'failed', message: error?.message || '本地授权助手无法启动' }))
    return true
  }
  if (message?.type === 'start-local-execution') {
    void startLocalExecution(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error?.message || 'Local execution failed' }))
    return true
  }
  if (message?.type === 'sync-auto-auth') {
    void syncActiveAutoAuth(message).then(sendResponse).catch((error) => sendResponse({ handled: true, ok: false, message: error?.message || '本地授权助手同步失败' }))
    return true
  }
  if (message?.type === 'preview-code') {
    void previewCode(message).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error?.message || '无法读取授权目标' }))
    return true
  }
  if (message?.type === 'sync-from-popup') {
    void syncFromPopup(message).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error?.message || '授权助手执行失败' }))
    return true
  }
  if (message?.type === 'auto-auth-page-signal') {
    if (sender.tab?.id) void queueAutoSync(sender.tab.id)
    return false
  }
  return false
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') void queueAutoSync(tabId)
})

chrome.tabs.onRemoved.addListener((tabId) => {
  void cancelClosedLoginTab(tabId)
})

chrome.alarms.onAlarm.addListener((alarm) => {
  void autoSyncRetryScheduler.handleAlarm(alarm)
})

async function startLocalExecution(message, sender) {
  const request = validateLocalExecutionStart(message)
  if (sender.frameId !== 0 || !sender.tab?.url) throw new Error('Local execution must come from a top-level configured tab')
  const stored = await chrome.storage.local.get(TRUSTED_AUTOAPI_ORIGIN_KEY)
  const autoApiOrigin = validateTrustedLocalExecutionOrigin({
    messageOrigin: message.origin,
    senderTabUrl: sender.tab.url,
    trustedOrigin: stored[TRUSTED_AUTOAPI_ORIGIN_KEY],
  })
  const jobKey = `${autoApiOrigin}\u0000${request.code}\u0000${request.operation}`
  const existing = localExecutionJobs.get(jobKey)
  if (existing) return existing

  const job = runLocalExecution(autoApiOrigin, request)
  localExecutionJobs.set(jobKey, job)
  try {
    return await job
  } finally {
    if (localExecutionJobs.get(jobKey) === job) localExecutionJobs.delete(jobKey)
  }
}

async function runLocalExecution(autoApiOrigin, request) {
  let claim = null
  let reportAttempted = false
  try {
    claim = await claimLocalExecution(autoApiOrigin, request)
    const tabId = await openHybgzsExecutionTab(claim.operation)
    const outcome = await executeHybgzsLocalExecution(tabId, claim.operation)
    reportAttempted = true
    await reportLocalExecution(autoApiOrigin, claim, outcome)
    return { ok: outcome.status === 'success' || outcome.status === 'already_checked', ...outcome }
  } catch (error) {
    const outcome = normalizeLocalExecutionOutcome({
      status: 'failed',
      message: error?.message || 'Local execution failed',
    })
    if (claim && !reportAttempted) await reportLocalExecution(autoApiOrigin, claim, outcome).catch(() => undefined)
    return { ok: false, ...outcome }
  }
}

async function claimLocalExecution(autoApiOrigin, request) {
  const response = await fetch(`${autoApiOrigin}/auth-assistant/local-execution/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: request.code, hostname: HYBGZS_LOCAL_EXECUTION_HOST }),
  })
  const payload = await readResponse(response)
  if (!response.ok) throw new Error(payload.error?.message || 'Local execution code is invalid')
  return validateLocalExecutionClaim(payload, request.operation)
}

async function reportLocalExecution(autoApiOrigin, claim, outcome) {
  const response = await fetch(`${autoApiOrigin}/auth-assistant/local-execution/report`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-autoapi-assistant-token': claim.resultToken,
    },
    body: JSON.stringify({
      executionId: claim.executionId,
      status: outcome.status,
      message: outcome.message,
      balanceRaw: outcome.balanceRaw,
      rewardRaw: outcome.rewardRaw,
    }),
  })
  const payload = await readResponse(response)
  if (!response.ok) throw new Error(payload.error?.message || `Local execution report failed (HTTP ${response.status})`)
}

async function openHybgzsExecutionTab(operation) {
  const checkinUrl = `https://${HYBGZS_LOCAL_EXECUTION_HOST}/gas-station/checkin`
  const tabs = await chrome.tabs.query({})
  let tab = tabs.find((candidate) => hasExactHybgzsHostname(candidate.url)) || null

  if (!tab?.id) {
    tab = await chrome.tabs.create({ url: operation === 'checkin' ? checkinUrl : `https://${HYBGZS_LOCAL_EXECUTION_HOST}/`, active: true })
  } else if (operation === 'checkin' && !hasHybgzsCheckinPath(tab.url)) {
    tab = await chrome.tabs.update(tab.id, { url: checkinUrl, active: true })
  } else {
    tab = await chrome.tabs.update(tab.id, { active: true })
  }

  if (!tab?.id) throw new Error('Unable to open the local Hybgzs tab')
  await waitForHybgzsTab(tab.id)
  return tab.id
}

async function waitForHybgzsTab(tabId) {
  const current = await chrome.tabs.get(tabId).catch(() => null)
  if (current?.status === 'complete' && hasExactHybgzsHostname(current.url)) return

  await new Promise((resolve, reject) => {
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      chrome.tabs.onUpdated.removeListener(listener)
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve()
    }
    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId) return
      if (changeInfo.status === 'complete' && hasExactHybgzsHostname(tab.url)) finish()
    }
    const timeout = setTimeout(() => finish(new Error('Timed out while opening cdk.hybgzs.com')), 20_000)
    chrome.tabs.onUpdated.addListener(listener)
    void chrome.tabs.get(tabId).then((latest) => {
      if (latest.status === 'complete' && hasExactHybgzsHostname(latest.url)) finish()
    }).catch(() => finish(new Error('The local Hybgzs tab was closed')))
  })
}

function hasExactHybgzsHostname(value) {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'https:'
      && url.hostname.toLowerCase().replace(/\.$/, '') === HYBGZS_LOCAL_EXECUTION_HOST
  } catch {
    return false
  }
}

function hasHybgzsCheckinPath(value) {
  try {
    const url = new URL(String(value || ''))
    return hasExactHybgzsHostname(url.toString()) && url.pathname === '/gas-station/checkin'
  } catch {
    return false
  }
}

async function executeHybgzsLocalExecution(tabId, operation) {
  const functionArgs = operation === 'balance_refresh' ? ['balance_refresh'] : ['checkin']
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: executeFixedHybgzsLocalExecution,
    args: functionArgs,
  })
  return normalizeLocalExecutionOutcome(results?.[0]?.result)
}

// Runs in the site's MAIN world. Its host, endpoints, UI text, and result
// shapes are intentionally fixed here rather than received from the server.
async function executeFixedHybgzsLocalExecution(operation) {
  const success = (message, balanceRaw = null, rewardRaw = null) => ({ status: 'success', message, balanceRaw, rewardRaw })
  const failed = (message, balanceRaw = null, rewardRaw = null) => ({ status: 'failed', message, balanceRaw, rewardRaw })
  const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null
  const unwrap = (payload) => {
    if (!payload || typeof payload !== 'object' || payload.success === false) return null
    return payload.data && typeof payload.data === 'object' ? payload.data : payload
  }
  const request = async (path) => {
    try {
      const response = await fetch(path, { credentials: 'include', headers: { accept: 'application/json' } })
      const payload = await response.json().catch(() => null)
      if (!response.ok) return null
      return unwrap(payload)
    } catch {
      return null
    }
  }
  const hasVerifiedUser = (data) => {
    const id = data?.user?.id
    if (typeof id === 'number') return Number.isFinite(id) && id > 0
    return typeof id === 'string' && id.trim().length > 0 && id.trim() !== '0'
  }
  const readBalance = (data) => finiteNumber(data?.total)
    ?? finiteNumber(data?.wallet?.balance)
    ?? finiteNumber(data?.mainSite?.balance)
  const readReward = (data) => finiteNumber(data?.todayCheckinInfo?.rewardQuota)
    ?? finiteNumber(data?.todayExpectedReward)
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  const capVisible = () => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ')
    return text.includes('\u95ea\u70c1\u53d1\u5149\u7684\u4eba\u7c7b\u8bf7\u9a8c\u8bc1')
      || text.includes('\u5b8c\u6210\u9a8c\u8bc1\u540e\u81ea\u52a8\u7b7e\u5230')
      || text.includes('\u70b9\u51fb\u9a8c\u8bc1')
      || text.includes('CAP')
  }
  const findCheckinButton = () => {
    const targetText = '\u7acb\u5373\u7b7e\u5230'
    return [...document.querySelectorAll('button, [role="button"]')].find((element) => {
      const text = (element.textContent || '').replace(/\s+/g, '')
      const visible = element.getClientRects().length > 0
      return visible && !element.disabled && text === targetText
    }) || null
  }

  const user = await request('/api/user/info')
  if (!hasVerifiedUser(user)) return failed('Login state is not verified')

  const beforeRaw = readBalance(await request('/api/wallet/balance'))
  if (operation === 'balance_refresh') {
    if (beforeRaw === null) return failed('Wallet balance is unavailable')
    return success('Balance refreshed', beforeRaw)
  }
  if (operation !== 'checkin') return failed('Local execution operation is invalid')

  const config = await request('/api/checkin/config')
  if (!config) return failed('Check-in configuration is unavailable', beforeRaw)
  if (config.hasCheckedInToday) {
    return { status: 'already_checked', message: 'Already checked in today', balanceRaw: beforeRaw, rewardRaw: readReward(config) }
  }

  const status = await request('/api/checkin/status')
  if (!status) return failed('Check-in status is unavailable', beforeRaw)
  if (status.enabled === false) return failed('Check-in is disabled', beforeRaw)

  const button = findCheckinButton()
  if (!button) return failed('The fixed check-in button was not found', beforeRaw)
  button.click()

  for (let attempt = 0; attempt < 6; attempt += 1) {
    await wait(750)
    const afterConfig = await request('/api/checkin/config')
    if (afterConfig?.hasCheckedInToday) {
      const afterRaw = readBalance(await request('/api/wallet/balance'))
      return success('Check-in completed', afterRaw, readReward(afterConfig))
    }
    if (capVisible()) {
      return {
        status: 'manual_required',
        message: 'CAP is open in the local check-in tab. Complete it there, then retry.',
        balanceRaw: beforeRaw,
        rewardRaw: null,
      }
    }
  }

  if (status.capRequired === true) {
    return {
      status: 'manual_required',
      message: 'CAP may be required in the local check-in tab. Complete it there, then retry.',
      balanceRaw: beforeRaw,
      rewardRaw: null,
    }
  }
  return failed('Check-in result was not confirmed', beforeRaw)
}

async function startAutoAuth({ origin, code, siteUrl, adapter }, sender) {
  const autoApiOrigin = normalizeOrigin(origin)
  const target = parseHttpUrl(siteUrl)
  const loginUrl = resolveLoginUrl(target, adapter)
  const claim = await claimPair(autoApiOrigin, code, target.hostname)
  if (!isAllowedHost(target.hostname, claim.domain)) {
    const message = `目标站点 ${target.hostname} 与授权站点 ${claim.domain} 不匹配`
    await reportFailure(autoApiOrigin, claim, message)
    throw new Error(message)
  }

  try {
    return await openAutoAuthTask({
      autoApiOrigin,
      claim,
      loginUrl,
      sourceTabId: sender.tab?.id || null,
    })
  } catch (error) {
    await reportFailure(autoApiOrigin, claim, error?.message || '无法打开本地浏览器登录页')
    throw error
  }
}

async function openAutoAuthTask({ autoApiOrigin, claim, loginUrl, sourceTabId }) {
  let task = null
  try {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: true })
    if (!tab.id) throw new Error('无法创建本地浏览器登录页')
    task = {
      pairId: claim.pairId,
      siteId: claim.siteId,
      siteName: claim.siteName,
      domain: claim.domain,
      expiresAt: claim.expiresAt,
      autoApiOrigin,
      secret: claim.secret,
      uploadToken: claim.uploadToken,
      tabId: tab.id,
      sourceTabId: Number.isInteger(sourceTabId) ? sourceTabId : null,
      loginUrl,
      statusPhase: 'opened',
      statusMessage: `已在本机浏览器打开 ${claim.siteName} 登录页，完成登录后会自动同步。`,
    }
    await saveTask(task)
    await chrome.storage.local.set({ origin: autoApiOrigin })
    await chrome.tabs.update(tab.id, { url: loginUrl, active: true })
    scheduleAutoSyncRetry(task.pairId, 2_500)
    await notifySource(task, task.statusPhase, task.statusMessage)
    return { ok: true, phase: task.statusPhase, message: task.statusMessage, opened: true, targetDomain: claim.domain }
  } catch (error) {
    if (task) await removeTask(task.pairId)
    throw error
  }
}

async function previewCode({ origin, code }) {
  const autoApiOrigin = normalizeOrigin(origin)
  const response = await fetch(`${autoApiOrigin}/auth-assistant/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: String(code || '').trim().toUpperCase() }),
  })
  const payload = await readResponse(response)
  if (!response.ok) throw new Error(payload.error?.message || '授权码不存在或已过期')
  if (!payload?.domain || !payload?.siteUrl || !payload?.pairId) throw new Error('授权助手返回了无效的目标站点')
  return { ok: true, ...payload }
}

async function queueAutoSync(tabId) {
  const task = await findTaskByTab(tabId)
  if (!task || queuedSyncs.has(task.pairId)) return
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (!tab?.url || !matchesTaskUrl(tab.url, task)) return

  queuedSyncs.set(task.pairId, true)
  await updateTaskStatus(task, 'checking', '正在检查本地浏览器的登录状态…')
  scheduleAutoSyncRetry(task.pairId, 900)
}

async function tryAutoSync(pairId) {
  const task = await getTask(pairId)
  if (!task) return
  if (Date.parse(task.expiresAt) <= Date.now()) {
    await removeTask(pairId)
    await notifySource(task, 'failed', '本地授权已过期，请回到后台重新发起授权。')
    return
  }

  const tab = await chrome.tabs.get(task.tabId).catch(() => null)
  if (!tab?.url || !matchesTaskUrl(tab.url, task)) {
    scheduleAutoSyncRetry(pairId)
    return
  }
  const current = parseHttpUrl(tab.url)
  const cookies = await readCurrentCookies(current)
  let storageItems = {}
  try {
    storageItems = await readCurrentStorage(task.tabId)
  } catch (error) {
    if (!cookies.length) {
      await updateTaskStatus(task, 'waiting-login', '等待站点登录完成。登录后页面会自动再次检查。')
      scheduleAutoSyncRetry(pairId)
      return
    }
  }

  // Some SPA login pages keep the password form mounted after authentication.
  // Session state is the reliable signal, so do not block a sync just because
  // a hidden or stale password input is still present in the DOM.
  if (!hasLikelyAuthState(cookies, storageItems, current.hostname)) {
    await updateTaskStatus(task, 'waiting-login', '等待站点登录完成。登录后页面会自动同步。')
    scheduleAutoSyncRetry(pairId)
    return
  }

  try {
    const result = await uploadClaimedSnapshot({ autoApiOrigin: task.autoApiOrigin, claim: task, tabId: task.tabId, current, cookies, storageItems })
    await removeTask(task.pairId)
    await closeCompletedLoginTab(task.tabId)
    await notifySource(task, 'synced', `登录状态已自动同步：${result.cookieCount} 个 Cookie、${result.localStorageCount} 个存储项。`)
  } catch (error) {
    const message = error?.message || '自动同步暂未完成'
    if (isTerminalAutoSyncFailure(error)) {
      await reportFailure(task.autoApiOrigin, task, message)
      await removeTask(task.pairId)
      await notifySource(task, 'failed', message)
      return
    }
    await updateTaskStatus(task, 'waiting-login', `自动同步暂未完成：${message}。保持登录页打开后刷新即可重试。`)
    scheduleAutoSyncRetry(pairId)
  }
}

async function closeCompletedLoginTab(tabId) {
  if (!Number.isInteger(tabId)) return
  await chrome.tabs.remove(tabId).catch(() => undefined)
}

async function cancelClosedLoginTab(tabId) {
  const task = await findTaskByTab(tabId)
  if (!task) return
  await removeTask(task.pairId)
  await reportFailure(task.autoApiOrigin, task, '本地浏览器登录页已关闭，请重新发起授权')
  await notifySource(task, 'failed', '本地浏览器登录页已关闭，请重新发起授权。')
}

async function syncActiveAutoAuth({ tabId, url }) {
  const task = await findTaskByTab(tabId)
  if (!task || !url || !matchesTaskUrl(url, task)) return { handled: false }
  const current = parseHttpUrl(url)
  const cookies = await readCurrentCookies(current)
  let storageItems = {}
  try {
    storageItems = await readCurrentStorage(tabId)
  } catch (error) {
    if (!cookies.length) return { handled: true, ok: false, message: error?.message || '未读取到当前页面登录状态，请先完成登录' }
  }
  if (!hasLikelyAuthState(cookies, storageItems, current.hostname)) {
    return { handled: true, ok: false, message: '未读取到登录会话，请先在当前页面完成登录后再同步' }
  }
  try {
    const result = await uploadClaimedSnapshot({ autoApiOrigin: task.autoApiOrigin, claim: task, tabId, current, cookies, storageItems })
    await removeTask(task.pairId)
    await notifySource(task, 'synced', `登录状态已同步：${result.cookieCount} 个 Cookie、${result.localStorageCount} 个存储项。`)
    return { handled: true, ...result }
  } catch (error) {
    const message = error?.message || '同步失败'
    if (isTerminalAutoSyncFailure(error)) {
      await reportFailure(task.autoApiOrigin, task, message)
      await removeTask(task.pairId)
      await notifySource(task, 'failed', message)
    }
    return { handled: true, ok: false, message }
  }
}

async function syncCurrentTab({ origin, code, tabId, url }) {
  const current = parseHttpUrl(url)
  const autoApiOrigin = normalizeOrigin(origin)
  const claim = await claimPair(autoApiOrigin, code, current.hostname)
  try {
    const cookies = await readCurrentCookies(current)
    let storageItems = {}
    try {
      storageItems = await readCurrentStorage(tabId)
    } catch (error) {
      if (!cookies.length) throw error
    }
    if (!hasLikelyAuthState(cookies, storageItems, current.hostname)) {
      throw new Error('未读取到登录会话，请先在当前页面完成登录后再同步')
    }
    return await uploadClaimedSnapshot({ autoApiOrigin, claim, tabId, current, cookies, storageItems })
  } catch (error) {
    await reportFailure(autoApiOrigin, claim, error?.message || '授权助手无法读取当前站点状态')
    return { ok: false, message: error?.message || '授权助手执行失败' }
  } finally {
    await chrome.storage.local.remove('code')
  }
}

async function syncFromPopup({ origin, code, tabId, url }) {
  const current = parseHttpUrl(url)
  const autoApiOrigin = normalizeOrigin(origin)
  const preview = await previewCode({ origin: autoApiOrigin, code })
  if (!isAllowedHost(current.hostname, preview.domain)) {
    const loginUrl = resolveLoginUrl(parseHttpUrl(preview.siteUrl), preview.adapter)
    const claim = await claimPair(autoApiOrigin, code, preview.domain)
    try {
      return await openAutoAuthTask({ autoApiOrigin, claim, loginUrl, sourceTabId: tabId })
    } catch (error) {
      await reportFailure(autoApiOrigin, claim, error?.message || '无法打开目标登录页')
      throw error
    }
  }
  return syncCurrentTab({ origin: autoApiOrigin, code, tabId, url })
}

async function claimPair(autoApiOrigin, code, hostname) {
  const claimResponse = await fetch(`${autoApiOrigin}/auth-assistant/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: String(code || '').trim().toUpperCase(), hostname }),
  })
  const claim = await readResponse(claimResponse)
  if (!claimResponse.ok) throw new Error(claim.error?.message || '授权码无效')
  if (!claim?.pairId || !claim?.secret || !claim?.uploadToken || !claim?.domain) throw new Error('授权助手返回了无效的配对信息')
  return claim
}

async function uploadClaimedSnapshot({ autoApiOrigin, claim, tabId, current, cookies, storageItems }) {
  if (!isAllowedHost(current.hostname, claim.domain)) throw new Error(`当前站点 ${current.hostname} 与目标站点 ${claim.domain} 不匹配`)
  const pageTitle = await readCurrentPageTitle(tabId)
  const plaintext = JSON.stringify({ siteOrigin: current.origin, pageTitle, cookies, localStorage: storageItems, sentAt: new Date().toISOString() })
  const secret = base64UrlToBytes(claim.secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await crypto.subtle.importKey('raw', secret, 'AES-GCM', false, ['encrypt'])
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)))
  const uploadResponse = await fetch(`${autoApiOrigin}/auth-assistant/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-autoapi-assistant-token': claim.uploadToken },
    body: JSON.stringify({ pairId: claim.pairId, iv: bytesToBase64Url(iv), ciphertext: bytesToBase64Url(encrypted) }),
  })
  const uploaded = await readResponse(uploadResponse)
  if (!uploadResponse.ok) {
    const error = new Error(uploaded.error?.message || `上传授权状态失败（HTTP ${uploadResponse.status}）`)
    error.status = uploadResponse.status
    throw error
  }
  await chrome.storage.local.set({ [TRUSTED_AUTOAPI_ORIGIN_KEY]: autoApiOrigin })
  return { ok: true, cookieCount: uploaded.status.cookieCount, localStorageCount: uploaded.status.localStorageCount }
}

async function readCurrentPageTitle(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (typeof tab.title === 'string' && tab.title.trim()) return tab.title.trim()
  } catch {
    // The tab can navigate while the service worker is reading it.
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => document.title || '',
    })
    return typeof results?.[0]?.result === 'string' ? results[0].result.trim() : ''
  } catch {
    return ''
  }
}

async function looksLikeLoginPage(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const isVisible = (element) => {
          const style = window.getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
        }
        const password = [...document.querySelectorAll('input[type="password"]')].find(isVisible)
        if (!password) return false
        const form = password.closest('form') || password.parentElement
        const text = `${form?.textContent || ''} ${document.title}`.replace(/\s+/g, ' ')
        const accountInput = form?.querySelector('input[type="email"], input[type="text"], input[name*="user" i], input[name*="email" i], input[autocomplete="username"]')
        return Boolean(accountInput) || /登录|登入|sign\s*in|log\s*in/i.test(text)
      },
    })
    return Boolean(results?.[0]?.result)
  } catch {
    return false
  }
}

async function readCurrentCookies(current) {
  const values = await Promise.all([
    chrome.cookies.getAll({ url: current.origin }),
    chrome.cookies.getAll({ domain: current.hostname }),
  ])
  const unique = new Map()
  for (const cookies of values) {
    for (const cookie of cookies) unique.set(`${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}`, cookie)
  }
  return [...unique.values()]
}

async function readCurrentStorage(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const items = {}
        for (const storage of [window.localStorage, window.sessionStorage]) {
          for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index)
            if (key) items[key] = storage.getItem(key) || ''
          }
        }
        return items
      },
    })
    return results?.[0]?.result || {}
  } catch (primaryError) {
    const fallback = await chrome.tabs.sendMessage(tabId, { type: 'read-storage' })
    if (!fallback || typeof fallback.items !== 'object') throw primaryError
    return fallback.items
  }
}

async function getTasks() {
  const result = await chrome.storage.session.get(AUTO_AUTH_TASKS_KEY)
  const tasks = result[AUTO_AUTH_TASKS_KEY]
  return tasks && typeof tasks === 'object' ? tasks : {}
}

async function getTask(pairId) {
  const tasks = await getTasks()
  return tasks[pairId] || null
}

async function findTaskByTab(tabId) {
  const tasks = await getTasks()
  return Object.values(tasks).find((task) => task?.tabId === tabId) || null
}

async function saveTask(task) {
  const tasks = await getTasks()
  tasks[task.pairId] = task
  await chrome.storage.session.set({ [AUTO_AUTH_TASKS_KEY]: tasks })
}

async function removeTask(pairId) {
  const tasks = await getTasks()
  delete tasks[pairId]
  await chrome.storage.session.set({ [AUTO_AUTH_TASKS_KEY]: tasks })
  await autoSyncRetryScheduler.clear(pairId)
}

function scheduleAutoSyncRetry(pairId, delayMs = 3_000) {
  autoSyncRetryScheduler.schedule(pairId, delayMs)
}

function isTerminalAutoSyncFailure(error) {
  const message = error?.message || ''
  const status = Number(error?.status)
  return /授权任务|授权码|Token|已结束|过期/.test(message) || [400, 401, 403, 404, 413].includes(status)
}

async function updateTaskStatus(task, phase, message) {
  if (task.statusPhase === phase && task.statusMessage === message) return
  const next = { ...task, statusPhase: phase, statusMessage: message }
  await saveTask(next)
  await notifySource(next, phase, message)
}

async function notifySource(task, phase, message) {
  if (!Number.isInteger(task.sourceTabId)) return
  await chrome.tabs.sendMessage(task.sourceTabId, { type: 'auto-auth-status', requestId: task.pairId, phase, message }).catch(() => undefined)
}

function matchesTaskUrl(url, task) {
  try {
    return isAllowedHost(parseHttpUrl(url).hostname, task.domain)
  } catch {
    return false
  }
}

function resolveLoginUrl(target, adapter) {
  if (adapter === 'sub2api') return new URL('/login', target).toString()
  return target.toString()
}

async function reportFailure(origin, claim, message) {
  await fetch(`${origin}/auth-assistant/fail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-autoapi-assistant-token': claim.uploadToken },
    body: JSON.stringify({ pairId: claim.pairId, message: String(message).slice(0, 500) }),
  }).catch(() => undefined)
}

function normalizeOrigin(value) {
  const parsed = new URL(String(value || '').trim())
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('autoAPI 地址必须是 HTTP/HTTPS 地址')
  return parsed.origin
}

function parseHttpUrl(value) {
  let parsed
  try { parsed = new URL(value) } catch { throw new Error('当前站点地址无效') }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('当前站点不是 HTTP/HTTPS 站点')
  return parsed
}

function isAllowedHost(host, target) {
  const normalizedHost = host.toLowerCase().replace(/\.$/, '')
  const normalizedTarget = target.toLowerCase().replace(/^\.+|\.$/g, '')
  if (normalizedHost === normalizedTarget || normalizedHost.endsWith(`.${normalizedTarget}`)) return true
  if (!normalizedTarget.endsWith(`.${normalizedHost}`)) return false
  const hostLabels = normalizedHost.split('.').filter(Boolean)
  const targetLabels = normalizedTarget.split('.').filter(Boolean)
  return hostLabels.length >= 2 && targetLabels.length - hostLabels.length <= 1
}

async function readResponse(response) {
  try { return await response.json() } catch { return {} }
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function bytesToBase64Url(value) {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
