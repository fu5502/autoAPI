import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const configuredDataRoot = process.env.AUTOAPI_CHECKIN_DATA_DIR ?? process.env.CHECKIN_DATA_DIR
const defaultDataRoot = path.resolve(projectRoot, configuredDataRoot ?? path.join('.autoapi-data', 'checkin'))

export const dataRoot = configuredDataRoot
  ? path.resolve(projectRoot, configuredDataRoot)
  : defaultDataRoot
export const browserProfileDir = path.join(dataRoot, 'browser-profile')
export const databasePath = path.join(dataRoot, 'checkin.sqlite')
export const serverHost = process.env.CHECKIN_HOST?.trim() || '0.0.0.0'
export const serverPort = readProjectPort(process.env.CHECKIN_PORT, 8080, 'CHECKIN_PORT')
export const appId = 'gongyi-checkin'
export const appVersion = '1.0.0'
export const publicUrl = process.env.CHECKIN_PUBLIC_URL?.trim() || 'http://localhost:8080'

function readProjectPort(value: string | undefined, fallback: number, variableName: string): number {
  const port = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error(`${variableName} 必须是 1024 到 65535 之间的整数`)
  }
  return port
}

export function ensureDataDirectories() {
  fs.mkdirSync(dataRoot, { recursive: true })
  fs.mkdirSync(browserProfileDir, { recursive: true })
}

export function findChromeExecutable(): string {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.PROGRAMFILES ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.PROGRAMFILES ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]
    : [
        process.env.CHROME_BIN ?? '',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
      ]

  const executable = candidates.find((candidate) => candidate && fs.existsSync(candidate))
  if (!executable) {
    throw new Error('未找到 Chrome 或 Edge，请先安装其中一个浏览器。')
  }
  return executable
}
