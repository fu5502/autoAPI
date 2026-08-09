import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { BrowserManager, closeStartupBlankPages, getChromiumLaunchEnvironment, removeStaleChromeLockFiles } from './browser-manager.js'

describe('closeStartupBlankPages', () => {
  it('closes only browser startup pages and keeps existing site tabs', async () => {
    const closed: string[] = []
    const page = (url: string): Page => ({
      url: () => url,
      isClosed: () => false,
      close: async () => { closed.push(url) },
    } as unknown as Page)
    const pages = [page('about:blank'), page('chrome://newtab/'), page('https://example.com/')]
    const context = { pages: () => pages } as unknown as BrowserContext

    await closeStartupBlankPages(context)

    expect(closed).toEqual(['chrome://newtab/'])
  })

  it('keeps the only startup page so Chrome does not close the CDP target', async () => {
    const closed: string[] = []
    const page = {
      url: () => 'about:blank',
      isClosed: () => false,
      close: async () => { closed.push('about:blank') },
    } as unknown as Page
    const context = { pages: () => [page] } as unknown as BrowserContext

    await closeStartupBlankPages(context)

    expect(closed).toEqual([])
  })

  it('keeps one blank page when Chrome exposes multiple startup pages', async () => {
    const closed: string[] = []
    const pages = ['about:blank', 'chrome://newtab/'].map((url) => ({
      url: () => url,
      isClosed: () => false,
      close: async () => { closed.push(url) },
    } as unknown as Page))
    const context = { pages: () => pages } as unknown as BrowserContext

    await closeStartupBlankPages(context)

    expect(closed).toEqual(['chrome://newtab/'])
  })
})

describe('BrowserManager connection recovery', () => {
  it('reconnects when a stale CDP context rejects newPage', async () => {
    const manager = new BrowserManager()
    const staleContext = {
      pages: () => [],
      newPage: async () => { throw new Error('browserContext.newPage: Target page, context or browser has been closed') },
    } as unknown as BrowserContext
    const taskPage = {
      url: () => 'https://dddai.dev/',
      isClosed: () => false,
      setDefaultTimeout: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as Page
    const freshContext = {
      pages: () => [],
      newPage: vi.fn(async () => taskPage),
    } as unknown as BrowserContext
    const browser = {
      isConnected: () => true,
      close: vi.fn(async () => undefined),
    }
    Object.assign(manager as unknown as Record<string, unknown>, {
      activeBrowser: browser,
      activeContext: staleContext,
    })
    vi.spyOn(manager as unknown as { ensureContext: () => Promise<BrowserContext> }, 'ensureContext')
      .mockResolvedValueOnce(staleContext)
      .mockResolvedValueOnce(freshContext)

    let receivedContext: BrowserContext | null = null
    const result = await manager.run({ interactive: false }, async (context, page) => {
      receivedContext = context
      return page
    })

    expect(receivedContext).toBe(freshContext)
    expect(result).toBe(taskPage)
    expect(freshContext.newPage).toHaveBeenCalledTimes(1)
    expect(browser.close).toHaveBeenCalledTimes(1)
    expect(taskPage.close).toHaveBeenCalledTimes(1)
  })

  it('closes the startup page after the task navigates it', async () => {
    const manager = new BrowserManager()
    let currentUrl = 'about:blank'
    const taskPage = {
      url: () => currentUrl,
      isClosed: () => false,
      setDefaultTimeout: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as Page
    const context = {
      pages: () => [taskPage],
      newPage: vi.fn(async () => taskPage),
    } as unknown as BrowserContext
    vi.spyOn(manager as unknown as { ensureContext: () => Promise<BrowserContext> }, 'ensureContext').mockResolvedValue(context)

    await manager.run({ interactive: false }, async () => {
      currentUrl = 'https://example.com/'
    })

    expect(taskPage.close).toHaveBeenCalledOnce()
  })

  it('enforces a hard per-site timeout and closes the active task page', async () => {
    const manager = new BrowserManager()
    const taskPage = {
      url: () => 'https://example.com/',
      isClosed: () => false,
      setDefaultTimeout: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as Page
    const context = {
      pages: () => [taskPage],
      newPage: vi.fn(async () => taskPage),
    } as unknown as BrowserContext
    vi.spyOn(manager as unknown as { ensureContext: () => Promise<BrowserContext> }, 'ensureContext').mockResolvedValue(context)
    const forceShutdown = vi.spyOn(manager, 'forceShutdown').mockResolvedValue(undefined)
    const shutdown = vi.spyOn(manager, 'shutdown')

    await expect(manager.run(
      { interactive: false, closeBrowserWhenDone: false, timeoutMs: 50 },
      async () => new Promise<void>(() => undefined),
    )).rejects.toThrow('站点执行超过')

    expect(taskPage.close).toHaveBeenCalled()
    expect(forceShutdown).toHaveBeenCalledOnce()
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('force closes the active page and shuts down the browser on cancel', async () => {
    const manager = new BrowserManager()
    const page = {
      isClosed: () => false,
      close: vi.fn(async () => undefined),
    } as unknown as Page
    Object.assign(manager as unknown as Record<string, unknown>, { activePage: page })
    const forceShutdown = vi.spyOn(manager, 'forceShutdown').mockResolvedValue(undefined)

    await manager.cancelActive()

    expect(page.close).toHaveBeenCalledWith({ runBeforeUnload: false })
    expect(forceShutdown).toHaveBeenCalledOnce()
  })

  it('gracefully cancels an active authorization without force-killing', async () => {
    const manager = new BrowserManager()
    const page = {
      isClosed: () => false,
      close: vi.fn(async () => undefined),
    } as unknown as Page
    Object.assign(manager as unknown as Record<string, unknown>, { activePage: page })
    const shutdown = vi.spyOn(manager, 'shutdown').mockResolvedValue(undefined)
    const forceShutdown = vi.spyOn(manager, 'forceShutdown')

    await manager.cancelActive({ force: false })

    expect(page.close).toHaveBeenCalledWith({ runBeforeUnload: false })
    expect(shutdown).toHaveBeenCalledOnce()
    expect(forceShutdown).not.toHaveBeenCalled()
  })

  it('bounds shutdown when the browser CDP connection hangs', async () => {
    const manager = new BrowserManager()
    const browser = {
      newBrowserCDPSession: async () => {
        throw new Error('disconnected')
      },
      close: () => new Promise<void>(() => undefined),
    } as unknown as Browser
    Object.assign(manager as unknown as Record<string, unknown>, { activeBrowser: browser })

    const startedAt = Date.now()
    await manager.shutdown()

    expect(Date.now() - startedAt).toBeLessThan(3_500)
  })

  it('bounds force shutdown when browser.close hangs', async () => {
    const manager = new BrowserManager()
    const browser = {
      close: () => new Promise<void>(() => undefined),
    } as unknown as Browser
    Object.assign(manager as unknown as Record<string, unknown>, { activeBrowser: browser })

    const startedAt = Date.now()
    await manager.forceShutdown()

    expect(Date.now() - startedAt).toBeLessThan(3_500)
  })
})

describe('Chrome profile lock recovery', () => {
  it('removes stale singleton locks when no Chromium process owns the profile', async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autoapi-browser-profile-'))
    try {
      await Promise.all(['SingletonLock', 'SingletonCookie', 'SingletonSocket'].map((name) => fs.writeFile(path.join(profileDir, name), 'stale')))

      await removeStaleChromeLockFiles(profileDir, false)

      await expect(fs.access(path.join(profileDir, 'SingletonLock'))).rejects.toThrow()
      await expect(fs.access(path.join(profileDir, 'SingletonCookie'))).rejects.toThrow()
      await expect(fs.access(path.join(profileDir, 'SingletonSocket'))).rejects.toThrow()
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true })
    }
  })

  it('keeps singleton locks when a Chromium process still owns the profile', async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autoapi-browser-profile-'))
    try {
      await fs.writeFile(path.join(profileDir, 'SingletonLock'), 'active')

      await removeStaleChromeLockFiles(profileDir, true)

      await expect(fs.access(path.join(profileDir, 'SingletonLock'))).resolves.toBeUndefined()
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true })
    }
  })
})

describe('Chromium launch environment', () => {
  it('provides stable Linux display defaults when the process has no display variables', () => {
    expect(getChromiumLaunchEnvironment({ PATH: '/usr/bin' }, 'linux')).toMatchObject({
      PATH: '/usr/bin',
      DISPLAY: ':99',
      XDG_RUNTIME_DIR: '/tmp/autoapi-runtime',
    })
  })

  it('preserves an explicitly configured Linux display', () => {
    expect(getChromiumLaunchEnvironment({ DISPLAY: ' :88 ', XDG_RUNTIME_DIR: '/run/user/1000' }, 'linux')).toMatchObject({
      DISPLAY: ':88',
      XDG_RUNTIME_DIR: '/run/user/1000',
    })
  })

  it('does not inject Linux-only variables on Windows', () => {
    expect(getChromiumLaunchEnvironment({ PATH: 'C:\\Windows' }, 'win32')).toEqual({ PATH: 'C:\\Windows' })
  })
})
