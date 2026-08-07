import { describe, expect, it } from 'vitest'
import { initialSiteName, resolveOfficialSiteName } from './site-name.js'

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
})
