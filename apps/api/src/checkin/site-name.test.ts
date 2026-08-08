import { describe, expect, it } from 'vitest'
import type { Site } from './types.js'
import { initialSiteName, officialNameForAuth, resolveOfficialSiteName } from './site-name.js'

describe('check-in site names', () => {
  it('uses the known official name instead of a browser title or hostname', () => {
    expect(initialSiteName('https://dy.chybenzun.top/')).toBe('CHY 流量签到')
    expect(resolveOfficialSiteName('https://cdk.hybgzs.com/', 'unknown', '错误页面')).toBe('黑与白福利站')
  })

  it('uses New API system_name as the official name for an unknown host', () => {
    expect(resolveOfficialSiteName('https://relay.example.com/', 'unknown', '我的 New API 站点')).toBe('我的 New API 站点')
    expect(resolveOfficialSiteName('https://relay.example.com/', 'unknown', '登录')).toBeNull()
  })

  it('keeps an explicitly supplied name when creating a site', () => {
    expect(initialSiteName('https://dy.chybenzun.top/', '我的签到入口')).toBe('我的签到入口')
  })

  it('fills a generated hostname from the first authorization and then freezes it', () => {
    const generated = {
      name: 'www.fastaitoken.com',
      baseUrl: 'https://www.fastaitoken.com',
      adapter: 'sub2api',
    } as unknown as Site
    expect(officialNameForAuth(generated, 'FastAI Token')).toBe('FastAI Token')

    const frozen = {
      name: 'FastAI Token',
      baseUrl: 'https://www.fastaitoken.com',
      adapter: 'sub2api',
    } as unknown as Site
    expect(officialNameForAuth(frozen, 'FastAI Token 页面')).toBe('FastAI Token')
  })

  it('keeps a manually edited site name across later authorizations', () => {
    const manual = {
      name: '我的固定站点名',
      baseUrl: 'https://relay.example',
      adapter: 'sub2api',
    } as unknown as Site
    expect(officialNameForAuth(manual, '页面标题')).toBe('我的固定站点名')
  })
})
