const PAGE_STATUS_EVENT = 'autoapi-auth-assistant-status'

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || typeof event.data !== 'object') return
  const data = event.data
  if (data.type !== 'autoapi-auth-assistant-start') return
  if (typeof data.requestId !== 'string' || typeof data.code !== 'string' || typeof data.siteUrl !== 'string') return

  void chrome.runtime.sendMessage({
    type: 'start-auto-auth',
    requestId: data.requestId,
    origin: event.origin,
    code: data.code,
    siteUrl: data.siteUrl,
    adapter: typeof data.adapter === 'string' ? data.adapter : '',
  }).then((result) => {
    publishStatus(data.requestId, result?.phase || (result?.ok ? 'opened' : 'failed'), result?.message || '本地授权助手未返回状态')
  }).catch((error) => {
    publishStatus(data.requestId, 'failed', error?.message || '本地授权助手无法启动')
  })
})

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'auto-auth-status' || typeof message.requestId !== 'string' || typeof message.phase !== 'string' || typeof message.message !== 'string') return false
  publishStatus(message.requestId, message.phase, message.message)
  return false
})

window.addEventListener('load', () => reportPageSignal('page-loaded'), { once: true })
window.addEventListener('pageshow', () => reportPageSignal('page-shown'))
window.addEventListener('hashchange', () => reportPageSignal('route-changed'))
window.addEventListener('popstate', () => reportPageSignal('route-changed'))
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') reportPageSignal('page-visible')
})
document.addEventListener('submit', () => reportPageSignal('form-submitted'), true)
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest('button, input[type="submit"], [role="button"]') : null
  if (!target) return
  const text = `${target.getAttribute('aria-label') || ''} ${target.textContent || ''} ${target.getAttribute('value') || ''}`.trim()
  if (!/登录|登入|sign\s*in|log\s*in|continue|继续|确认|submit/i.test(text)) return
  reportPageSignal('login-action')
  for (const delay of [1_500, 4_000, 8_000]) window.setTimeout(() => reportPageSignal('login-action-follow-up'), delay)
}, true)

// Keep the automatic flow working with Chinese buttons and SPA login pages.
// The original listener only matched translated text literals.
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest('button, input[type="submit"], [role="button"], a[href*="login"], a[href*="sign-in"]') : null
  if (!target) return
  const text = `${target.getAttribute('aria-label') || ''} ${target.textContent || ''} ${target.getAttribute('value') || ''}`.trim()
  if (!/登录|登入|登陆|sign\s*in|log\s*in|continue|继续|确认|submit/i.test(text)) return
  reportPageSignal('login-action-cn')
  for (const delay of [1_500, 4_000, 8_000, 15_000]) window.setTimeout(() => reportPageSignal('login-action-follow-up'), delay)
}, true)

let lastSignalAt = 0
function reportPageSignal(signal) {
  const now = Date.now()
  if (now - lastSignalAt < 800) return
  lastSignalAt = now
  void chrome.runtime.sendMessage({ type: 'auto-auth-page-signal', signal, url: window.location.href }).catch(() => undefined)
}

function publishStatus(requestId, phase, message) {
  window.postMessage({ type: PAGE_STATUS_EVENT, requestId, phase, message }, window.location.origin)
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'read-storage') return false
  const items = {}
  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key) items[key] = storage.getItem(key) || ''
    }
  }
  sendResponse({ items })
  return true
})
