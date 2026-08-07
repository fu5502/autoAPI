const originInput = document.querySelector('#origin')
const codeInput = document.querySelector('#code')
const syncButton = document.querySelector('#sync')
const statusNode = document.querySelector('#status')

chrome.storage.local.get(['origin', 'code'], (values) => {
  originInput.value = values.origin || ''
  codeInput.value = values.code || ''
})

syncButton.addEventListener('click', async () => {
  syncButton.disabled = true
  statusNode.className = ''
  statusNode.textContent = '正在连接后台…'
  try {
    const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
    if (!tab?.id || !tab.url || !/^https?:\/\//i.test(tab.url)) throw new Error('当前标签页不是 HTTP/HTTPS 站点')
    const automatic = await chrome.runtime.sendMessage({ type: 'sync-auto-auth', tabId: tab.id, url: tab.url })
    if (automatic?.handled) {
      if (!automatic.ok) throw new Error(automatic.message || '请先完成当前站点登录')
      statusNode.className = 'success'
      statusNode.textContent = `同步成功：${automatic.cookieCount} 个 Cookie，${automatic.localStorageCount} 个存储项`
      return
    }
    const origin = normalizeOrigin(originInput.value)
    const code = codeInput.value.trim().toUpperCase()
    if (!/^https?:\/\//i.test(origin) || !code) throw new Error('请填写 autoAPI 地址和授权码')
    await chrome.storage.local.set({ origin, code })
    statusNode.textContent = '正在确认授权目标…'
    const target = await chrome.runtime.sendMessage({ type: 'preview-code', origin, code })
    if (!target?.ok) throw new Error(target?.message || '无法读取授权目标')
    if (!isAllowedHost(new URL(tab.url).hostname, target.domain)) {
      const opened = await chrome.runtime.sendMessage({ type: 'sync-from-popup', origin, code, tabId: tab.id, url: tab.url })
      if (!opened?.opened) throw new Error(opened?.message || `当前页面与目标站点 ${target.domain} 不匹配`)
      statusNode.className = ''
      statusNode.textContent = `已打开 ${target.domain}，完成登录后会自动同步到 autoAPI。`
      return
    }
    statusNode.textContent = '正在读取当前站点登录状态…'
    const snapshot = await chrome.runtime.sendMessage({ type: 'sync-from-popup', origin, code, tabId: tab.id, url: tab.url })
    if (!snapshot.ok) throw new Error(snapshot.message || '同步失败')
    statusNode.className = 'success'
    statusNode.textContent = `同步成功：${snapshot.cookieCount} 个 Cookie，${snapshot.localStorageCount} 个存储项`
  } catch (error) {
    statusNode.className = 'error'
    statusNode.textContent = error?.message || '同步失败'
  } finally {
    syncButton.disabled = false
  }
})

function normalizeOrigin(value) {
  const parsed = new URL(value.trim())
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('autoAPI 地址必须是 HTTP/HTTPS 地址')
  return parsed.origin
}

function isAllowedHost(host, target) {
  const normalizedHost = host.toLowerCase().replace(/\.$/, '')
  const normalizedTarget = target.toLowerCase().replace(/^\.+|\.$/g, '')
  return normalizedHost === normalizedTarget || normalizedHost.endsWith(`.${normalizedTarget}`) || normalizedTarget.endsWith(`.${normalizedHost}`)
}
