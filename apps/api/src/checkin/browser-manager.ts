import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { browserProfileDir, findChromeExecutable } from './config.js'

const debugPortFile = path.join(browserProfileDir, 'DebugPort')
const chromeSingletonLockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket']

/** Remove Chromium's stale profile locks without touching a profile in use. */
export async function removeStaleChromeLockFiles(profileDir: string, profileInUse: boolean): Promise<boolean> {
  if (profileInUse) return false
  let removed = false
  await Promise.all(chromeSingletonLockFiles.map(async (name) => {
    try {
      await fs.rm(path.join(profileDir, name), { force: true })
      removed = true
    } catch {
      // A lock can disappear between the process check and cleanup.
    }
  }))
  return removed
}

export class BrowserManager {
  private queue: Promise<void> = Promise.resolve()
  private activeBrowser: Browser | null = null
  private activeContext: BrowserContext | null = null
  private activePage: Page | null = null
  private contextPromise: Promise<BrowserContext> | null = null
  private chromeProcess: ChildProcess | null = null
  private chromeProcessId: number | null = null
  private busy = false

  isBusy() {
    return this.busy
  }

  async run<T>(
    options: { interactive: boolean; closeBrowserWhenDone?: boolean; timeoutMs?: number },
    task: (context: BrowserContext, page: Page) => Promise<T>,
  ): Promise<T> {
    let release!: () => void
    const slot = new Promise<void>((resolve) => { release = resolve })
    const previous = this.queue
    this.queue = previous.then(() => slot)
    await previous
    this.busy = true
    let timeout: NodeJS.Timeout | null = null
    let timedOut = false
    let taskPromise: Promise<T> | null = null
    const timeoutPromise = options.timeoutMs === undefined
      ? null
      : new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true
          void this.cancelActive().catch(() => undefined)
          reject(new Error(`站点执行超过 ${options.timeoutMs! / 1000} 秒，已终止`))
        }, options.timeoutMs)
      })
    try {
      let context = await this.ensureContext()
      let page: Page
      try {
        page = await this.createTaskPage(context)
      } catch (error) {
        if (!isClosedTargetError(error)) throw error
        await this.resetConnection(context)
        context = await this.ensureContext()
        page = await this.createTaskPage(context)
      }
      this.activePage = page
      page.setDefaultTimeout(30_000)
      page.setDefaultNavigationTimeout(45_000)
      await setWindowState(context, page, options.interactive ? 'normal' : 'minimized')
      if (options.interactive) await page.bringToFront()
      taskPromise = Promise.resolve().then(() => task(context, page))
      return timeoutPromise
        ? await Promise.race([taskPromise, timeoutPromise])
        : await taskPromise
    } catch (error) {
      if (timedOut) taskPromise?.catch(() => undefined)
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
      const page = this.activePage
      this.activePage = null
      // Keep Chrome's sole startup target alive only when the task left it
      // untouched. Once it navigated, it is a task page and must be closed.
      const preserveStartupPage = Boolean(page && !page.isClosed() && isStartupBlankPage(page))
      if (options.closeBrowserWhenDone) {
        if (page && !page.isClosed()) await page.close().catch(() => undefined)
        await this.shutdown()
      } else if (!preserveStartupPage && page && !page.isClosed()) {
        await page.close().catch(() => undefined)
      }
      this.busy = false
      release()
    }
  }

  async runContext<T>(task: (context: BrowserContext) => Promise<T>): Promise<T> {
    let release!: () => void
    const slot = new Promise<void>((resolve) => { release = resolve })
    const previous = this.queue
    this.queue = previous.then(() => slot)
    await previous
    this.busy = true

    try {
      return await task(await this.ensureContext())
    } finally {
      this.busy = false
      release()
    }
  }

  async cancelActive() {
    const page = this.activePage
    if (page && !page.isClosed()) {
      await Promise.race([
        page.close({ runBeforeUnload: false }).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1_500)),
      ])
    }
    await this.forceShutdown().catch(() => undefined)
  }

  async forceShutdown() {
    const browser = this.activeBrowser
    const chromeProcess = this.chromeProcess
    const chromeProcessId = this.chromeProcessId ?? chromeProcess?.pid ?? null
    this.activeBrowser = null
    this.activeContext = null
    this.contextPromise = null
    this.chromeProcess = null
    this.chromeProcessId = null
    if (chromeProcessId) {
      await terminateProcessTree(chromeProcessId, chromeProcess)
    } else if (chromeProcess && !chromeProcess.killed) {
      chromeProcess.kill()
    }
    await browser?.close().catch(() => undefined)
    await fs.rm(debugPortFile, { force: true }).catch(() => undefined)
  }

  async shutdown() {
    const browser = this.activeBrowser
    const chromeProcess = this.chromeProcess
    const chromeProcessId = this.chromeProcessId ?? chromeProcess?.pid ?? null
    this.activeBrowser = null
    this.activeContext = null
    this.contextPromise = null
    this.chromeProcess = null
    this.chromeProcessId = null
    // Chrome 只有正常退出时才会把最新的 Cookie 和会话刷写到磁盘。connectOverCDP 的
    // browser.close() 只断开调试连接、不会让 Chrome 退出，所以先通过 CDP 的 Browser.close
    // 请求 Chrome 自行优雅退出，确认进程结束后再断开；只有优雅退出失败时才强制结束进程树。
    const closedGracefully = await this.closeChromeGracefully(browser, chromeProcessId)
    await browser?.close().catch(() => undefined)
    if (!closedGracefully) {
      if (chromeProcessId) await terminateProcessTree(chromeProcessId, chromeProcess)
      else if (chromeProcess && !chromeProcess.killed) chromeProcess.kill()
    }
    await fs.rm(debugPortFile, { force: true }).catch(() => undefined)
  }

  private async closeChromeGracefully(browser: Browser | null, processId: number | null): Promise<boolean> {
    if (!browser) return false
    try {
      const session = await browser.newBrowserCDPSession()
      await session.send('Browser.close')
      // Browser.close 会在 Chrome 开始关闭时返回；等待操作系统进程真正退出，
      // 以保证 Cookie 已经落盘。无法拿到进程号时视为已成功请求关闭。
      if (processId === null) return true
      return await waitForProcessExit(processId, 6_000)
    } catch {
      return false
    }
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.activeContext && this.activeBrowser?.isConnected()) return this.activeContext
    if (this.activeContext || this.activeBrowser) await this.resetConnection()
    if (!this.contextPromise) {
      this.contextPromise = this.connectOrLaunchChrome().catch((error) => {
        this.contextPromise = null
        throw error
      })
    }
    return this.contextPromise
  }

  private async createTaskPage(context: BrowserContext): Promise<Page> {
    const startupPage = findStartupBlankPage(context)
    if (startupPage && !startupPage.isClosed()) return startupPage
    return context.newPage()
  }

  private async resetConnection(expectedContext?: BrowserContext): Promise<void> {
    if (expectedContext && this.activeContext !== expectedContext) return
    const browser = this.activeBrowser
    this.activeBrowser = null
    this.activeContext = null
    this.contextPromise = null
    await browser?.close().catch(() => undefined)
  }

  private async connectOrLaunchChrome(): Promise<BrowserContext> {
    const existingEndpoint = await readDebugEndpoint()
    if (existingEndpoint) {
      try {
        const context = await this.connectToChrome(existingEndpoint.port, 1_000)
        this.chromeProcessId = existingEndpoint.pid
        return context
      } catch {
        this.chromeProcessId = null
        await fs.rm(debugPortFile, { force: true }).catch(() => undefined)
      }
    }

    const debugPort = await findAvailablePort()
    // Chrome leaves this file behind after an interrupted launch. It is not
    // used by our CDP bookkeeping, so remove it before starting a new session.
    await fs.rm(path.join(browserProfileDir, 'DevToolsActivePort'), { force: true }).catch(() => undefined)
    if (process.platform === 'linux') {
      await removeStaleChromeLockFiles(browserProfileDir, await isChromeProfileInUse(browserProfileDir))
    }
    const launchEnvironment = await prepareChromiumLaunchEnvironment()
    const chromeProcess = spawn(findChromeExecutable(), [
      `--remote-debugging-port=${debugPort}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${browserProfileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-mode',
      '--disable-extensions',
      '--disable-features=Translate',
      ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
      'about:blank',
    ], {
      detached: false,
      env: launchEnvironment,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let launchDiagnostics = ''
    chromeProcess.stderr?.setEncoding('utf8')
    chromeProcess.stderr?.on('data', (chunk) => {
      launchDiagnostics = `${launchDiagnostics}${String(chunk)}`.slice(-2_000)
    })
    this.chromeProcess = chromeProcess
    this.chromeProcessId = chromeProcess.pid ?? null
    chromeProcess.unref()

    try {
      const context = await this.waitForChrome(debugPort, chromeProcess, () => launchDiagnostics)
      await fs.writeFile(debugPortFile, JSON.stringify({ port: debugPort, pid: chromeProcess.pid ?? null }), 'utf8')
      return context
    } catch (error) {
      if (!chromeProcess.killed) chromeProcess.kill()
      if (this.chromeProcess === chromeProcess) this.chromeProcess = null
      if (this.chromeProcessId === chromeProcess.pid) this.chromeProcessId = null
      throw error
    }
  }

  private async waitForChrome(port: number, chromeProcess: ChildProcess, getDiagnostics: () => string): Promise<BrowserContext> {
    let launchError: Error | null = null
    chromeProcess.once('error', (error) => { launchError = error })
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (launchError) throw launchError
      try {
        return await this.connectToChrome(port, 500)
      } catch {
        if (launchError) throw launchError
        if (chromeProcess.exitCode !== null) {
          const diagnostics = getDiagnostics().replace(/\s+/g, ' ').trim()
          throw new Error(`Chrome 启动后立即退出${diagnostics ? `：${diagnostics}` : ''}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    throw new Error('等待 Chrome 启动超时')
  }

  private async connectToChrome(port: number, timeout: number = 15_000): Promise<BrowserContext> {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout })
    const context = browser.contexts()[0]
    if (!context) {
      await browser.close().catch(() => undefined)
      throw new Error('无法连接 Chrome 默认浏览器上下文')
    }

    this.activeBrowser = browser
    this.activeContext = context
    browser.on('disconnected', () => {
      if (this.activeBrowser !== browser) return
      this.activeBrowser = null
      this.activeContext = null
      this.contextPromise = null
      this.chromeProcess = null
      this.chromeProcessId = null
      void fs.rm(debugPortFile, { force: true }).catch(() => undefined)
    })
    await closeStartupBlankPages(context)
    return context
  }
}

/** Build a deterministic Linux display environment for the Chromium child process. */
export function getChromiumLaunchEnvironment(environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const launchEnvironment = { ...environment }
  if (platform === 'linux') {
    launchEnvironment.DISPLAY = launchEnvironment.DISPLAY?.trim() || ':99'
    launchEnvironment.XDG_RUNTIME_DIR = launchEnvironment.XDG_RUNTIME_DIR?.trim() || '/tmp/autoapi-runtime'
  }
  return launchEnvironment
}

async function prepareChromiumLaunchEnvironment(): Promise<NodeJS.ProcessEnv> {
  const launchEnvironment = getChromiumLaunchEnvironment()
  if (process.platform !== 'linux') return launchEnvironment

  const runtimeDir = launchEnvironment.XDG_RUNTIME_DIR
  if (runtimeDir) {
    await fs.mkdir(runtimeDir, { recursive: true })
    await fs.chmod(runtimeDir, 0o700).catch(() => undefined)
  }
  await assertLinuxDisplaySocket(launchEnvironment.DISPLAY ?? ':99')
  return launchEnvironment
}

async function assertLinuxDisplaySocket(display: string): Promise<void> {
  const match = /^(?:unix\/)?:(\d+)(?:\.\d+)?$/.exec(display.trim())
  if (!match) return
  const socketPath = `/tmp/.X11-unix/X${match[1]}`
  try {
    await fs.access(socketPath)
  } catch {
    throw new Error(`Chromium 启动前未检测到 X Server（DISPLAY=${display}）。请确认容器已启动 Xvfb，且等待显示服务就绪后再执行签到。`)
  }
}

async function isChromeProfileInUse(profileDir: string): Promise<boolean> {
  if (process.platform !== 'linux') return true
  let entries: string[]
  try {
    entries = await fs.readdir('/proc')
  } catch {
    // Fail closed when process inspection is unavailable.
    return true
  }

  const profileArgument = `--user-data-dir=${profileDir}`
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue
    try {
      const commandLine = await fs.readFile(path.join('/proc', entry, 'cmdline'), 'utf8')
      if (commandLine.includes(profileArgument)) return true
    } catch {
      // Processes can exit while /proc is being scanned.
    }
  }
  return false
}

/** Remove tabs opened by Chrome itself while preserving existing user tabs. */
export async function closeStartupBlankPages(context: BrowserContext): Promise<void> {
  const pages = context.pages()
  const blankPages = pages.filter(isStartupBlankPage)
  const keepPage = blankPages.find((page) => !page.isClosed()) ?? null
  await Promise.all(blankPages.map(async (page) => {
    if (page === keepPage) return
    if (page.isClosed()) return
    await page.close().catch(() => undefined)
  }))
}

function findStartupBlankPage(context: BrowserContext): Page | null {
  return context.pages().find((page) => !page.isClosed() && isStartupBlankPage(page)) ?? null
}

function isStartupBlankPage(page: Page): boolean {
  try {
    const url = page.url().trim().toLowerCase().replace(/\/$/, '')
    return ['about:blank', 'chrome://newtab', 'chrome://new-tab-page'].includes(url)
  } catch {
    return false
  }
}

function isClosedTargetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /target page, context or browser has been closed|browsercontext\.newpage|context or browser has been closed|target.*closed/i.test(message)
}

async function terminateProcessTree(processId: number, child: ChildProcess | null) {
  if (process.platform === 'win32') {
    const exitCode = await new Promise<number | null>((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(processId), '/T', '/F'], {
        detached: false,
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.once('error', () => resolve(null))
      killer.once('exit', (code) => resolve(code))
    })
    if (exitCode === 0) return
  }
  if (child && !child.killed && child.exitCode === null) child.kill()
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    // ESRCH 表示进程已退出；EPERM 表示进程仍在但无权限，视为存活。
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

async function waitForProcessExit(processId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(processId)) return true
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return !isProcessAlive(processId)
}

async function readDebugEndpoint(): Promise<{ port: number; pid: number | null } | null> {
  try {
    const content = await fs.readFile(debugPortFile, 'utf8')
    try {
      const parsed = JSON.parse(content) as { port?: unknown; pid?: unknown }
      const port = Number(parsed.port)
      const pid = Number(parsed.pid)
      return Number.isInteger(port) && port > 0
        ? { port, pid: Number.isInteger(pid) && pid > 0 ? pid : null }
        : null
    } catch {
      const port = Number(content.trim())
      return Number.isInteger(port) && port > 0 ? { port, pid: null } : null
    }
  } catch {
    return null
  }
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function setWindowState(context: BrowserContext, page: Page, windowState: 'normal' | 'minimized') {
  try {
    const session = await context.newCDPSession(page)
    const { windowId } = await session.send('Browser.getWindowForTarget') as { windowId: number }
    if (windowState === 'normal') {
      const screen = await page.evaluate(() => ({
        left: Number.isFinite((window.screen as Screen & { availLeft?: number }).availLeft)
          ? (window.screen as Screen & { availLeft?: number }).availLeft ?? 0
          : 0,
        top: Number.isFinite((window.screen as Screen & { availTop?: number }).availTop)
          ? (window.screen as Screen & { availTop?: number }).availTop ?? 0
          : 0,
        width: Math.max(window.screen.availWidth || window.innerWidth, 1024),
        height: Math.max(window.screen.availHeight || window.innerHeight, 700),
      })).catch(() => ({ left: 0, top: 0, width: 1920, height: 1080 }))
      const width = Math.min(1280, Math.max(960, screen.width - 120))
      const height = Math.min(900, Math.max(680, screen.height - 120))
      const x = Math.round(screen.left + Math.max(0, (screen.width - width) / 2))
      const y = Math.round(screen.top + Math.max(0, (screen.height - height) / 2))
      // Restore the normal state before applying coordinates. Chrome may ignore
      // left/top while the target is still minimized or maximized.
      await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: { width, height, left: x, top: y },
      })
    } else {
      await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState } })
    }
    await session.detach()
  } catch {
    // Window management is best-effort; authentication still works without it.
  }
}
