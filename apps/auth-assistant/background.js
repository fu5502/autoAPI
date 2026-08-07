const AUTO_AUTH_TASKS_KEY = 'autoapi-auto-auth-tasks'
const queuedSyncs = new Map()

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'sync') {
    void syncCurrentTab(message).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error?.message || '授权助手执行失败' }))
    return true
  }
  if (message?.type === 'start-auto-auth') {
    void startAutoAuth(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, phase: 'failed', message: error?.message || '本地授权助手无法启动' }))
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
  setTimeout(() => {
    queuedSyncs.delete(task.pairId)
    void tryAutoSync(task.pairId)
  }, 900)
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
  if (!tab?.url || !matchesTaskUrl(tab.url, task)) return
  const current = parseHttpUrl(tab.url)
  const cookies = await readCurrentCookies(current)
  let storageItems = {}
  try {
    storageItems = await readCurrentStorage(task.tabId)
  } catch (error) {
    if (!cookies.length) {
      await updateTaskStatus(task, 'waiting-login', '等待站点登录完成。登录后页面会自动再次检查。')
      return
    }
  }

  // Some SPA login pages keep the password form mounted after authentication.
  // Session state is the reliable signal, so do not block a sync just because
  // a hidden or stale password input is still present in the DOM.
  if (!hasLikelyAuthState(cookies, storageItems)) {
    await updateTaskStatus(task, 'waiting-login', '等待站点登录完成。登录后页面会自动同步。')
    return
  }

  try {
    const result = await uploadClaimedSnapshot({ autoApiOrigin: task.autoApiOrigin, claim: task, tabId: task.tabId, current, cookies, storageItems })
    await removeTask(task.pairId)
    await notifySource(task, 'synced', `登录状态已自动同步：${result.cookieCount} 个 Cookie、${result.localStorageCount} 个存储项。`)
  } catch (error) {
    const message = error?.message || '自动同步暂未完成'
    if (/授权任务|授权码|Token|已结束|过期/.test(message)) {
      await removeTask(task.pairId)
      await notifySource(task, 'failed', message)
      return
    }
    await updateTaskStatus(task, 'waiting-login', `自动同步暂未完成：${message}。保持登录页打开后刷新即可重试。`)
  }
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
  if (!hasLikelyAuthState(cookies, storageItems)) {
    return { handled: true, ok: false, message: '未读取到登录会话，请先在当前页面完成登录后再同步' }
  }
  try {
    const result = await uploadClaimedSnapshot({ autoApiOrigin: task.autoApiOrigin, claim: task, tabId, current, cookies, storageItems })
    await removeTask(task.pairId)
    await notifySource(task, 'synced', `登录状态已同步：${result.cookieCount} 个 Cookie、${result.localStorageCount} 个存储项。`)
    return { handled: true, ...result }
  } catch (error) {
    const message = error?.message || '同步失败'
    if (/授权任务|授权码|Token|已结束|过期/.test(message)) {
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
  const plaintext = JSON.stringify({ siteOrigin: current.origin, cookies, localStorage: storageItems, sentAt: new Date().toISOString() })
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
  if (!uploadResponse.ok) throw new Error(uploaded.error?.message || '上传授权状态失败')
  return { ok: true, cookieCount: uploaded.status.cookieCount, localStorageCount: uploaded.status.localStorageCount }
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

function hasLikelyAuthState(cookies, storageItems) {
  const isAuthName = (value) => /session|auth|token|access|jwt|login|user|sid/i.test(value) && !/csrf|xsrf|nonce|state/i.test(value)
  if (cookies.some((cookie) => isAuthName(String(cookie.name || '')))) return true
  return Object.keys(storageItems).some(isAuthName)
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
