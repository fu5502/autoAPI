import type { AppSettings, CheckinResult, CheckinRun } from './types.js'
import { AppDatabase } from './db.js'

type Fetcher = typeof fetch
type TelegramConfig = Pick<AppSettings, 'telegramEnabled' | 'telegramBotToken' | 'telegramChatId'>
type SummaryResult = Pick<CheckinResult, 'siteId' | 'siteName' | 'status' | 'rewardAmount' | 'message'> & {
  currencySymbol: string
  balanceAmount: number | null
}

export class TelegramNotifier {
  constructor(
    private readonly db: AppDatabase,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async notifyRun(run: CheckinRun, results: CheckinResult[]): Promise<boolean> {
    const settings = this.db.getSettings()
    if (!settings.telegramEnabled || run.trigger === 'retry') return false

    const sites = this.db.listSites()
    const siteById = new Map(sites.map((site) => [site.id, site]))
    const summaryResults = results.map((result): SummaryResult => {
      const site = siteById.get(result.siteId)
      return {
        siteId: result.siteId,
        siteName: result.siteName,
        status: result.status,
        rewardAmount: result.rewardAmount,
        message: result.message,
        currencySymbol: site?.currencySymbol ?? '$',
        balanceAmount: result.balanceAfterAmount ?? result.balanceBeforeAmount ?? site?.lastBalanceAmount ?? null,
      }
    })
    await this.sendMessage(settings, formatRunSummary({
      totalSites: sites.length,
      enabledSites: sites.filter((site) => site.enabled).length,
      results: summaryResults,
      completedAt: run.completedAt ?? run.startedAt,
    }))
    return true
  }

  async sendTest(config: Pick<TelegramConfig, 'telegramBotToken' | 'telegramChatId'>) {
    await this.sendMessage({ ...config, telegramEnabled: true }, formatRunSummary({
      totalSites: 15,
      enabledSites: 13,
      results: [
        { siteId: 1, siteName: '烁', status: 'success', rewardAmount: 1.25, message: '签到成功', currencySymbol: '$', balanceAmount: 174.18 },
        { siteId: 2, siteName: '月城公益站', status: 'already_checked', rewardAmount: 2.5, message: '今日已签到', currencySymbol: '$', balanceAmount: 66.15 },
        { siteId: 3, siteName: 'Any Router', status: 'failed', rewardAmount: null, message: '签到接口返回异常', currencySymbol: '$', balanceAmount: 12.5 },
        { siteId: 4, siteName: '示例公益站', status: 'manual_required', rewardAmount: null, message: '登录状态已失效', currencySymbol: '¥', balanceAmount: null },
      ],
      completedAt: new Date().toISOString(),
    }))
  }

  private async sendMessage(config: TelegramConfig, text: string) {
    const token = config.telegramBotToken.trim()
    const chatId = config.telegramChatId.trim()
    if (!token || !chatId) throw new Error('请先填写 Telegram Bot Token 和 Chat ID')

    const formatted = text.length <= 4000
      ? { text, parse_mode: 'HTML' as const }
      : { text: `${stripHtml(text).slice(0, 3950)}\n\n… 详细结果过长，已截断` }
    const response = await this.fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        ...formatted,
        disable_web_page_preview: true,
      }),
    })
    const payload = await response.json().catch(() => null) as { ok?: boolean; description?: string } | null
    if (!response.ok || payload?.ok !== true) {
      throw new Error(payload?.description || `Telegram 返回 HTTP ${response.status}`)
    }
  }
}

export function formatRunSummary(
  input: {
    totalSites: number
    enabledSites: number
    results: SummaryResult[]
    completedAt: string
  },
) {
  const successful = input.results.filter((result) => ['success', 'already_checked'].includes(result.status))
  const failures = input.results.filter((result) => !['success', 'already_checked'].includes(result.status))
  const inactiveSites = Math.max(0, input.totalSites - input.enabledSites)
  const rewardSummary = summarizeRewards(successful)
  const successLines = successful.length
    ? successful.map((result, index) => {
        const amount = result.rewardAmount === null ? '' : `  <code>${formatAmount(result.rewardAmount, result.currencySymbol)}</code>`
        const balance = result.balanceAmount === null ? '--' : `<code>${formatBalance(result.balanceAmount, result.currencySymbol)}</code>`
        return [
          `${index + 1}. ✅ <b>${escapeHtml(result.siteName)}</b>${amount}`,
          `   💰 总额度：${balance}`,
        ].join('\n')
      })
    : ['暂无成功站点']
  const failureLines = failures.map((result, index) => [
    `${index + 1}. ❌ <b>${escapeHtml(result.siteName)}</b>`,
    `   <i>原因：</i>${escapeHtml(result.message)}`,
  ].join('\n'))
  return [
    '<b>📊 公益站每日签到</b>',
    `<code>${formatTime(input.completedAt)}</code>`,
    '',
    '<b>运行概览</b>',
    `🌐 站点总数：<b>${input.totalSites}</b> 个`,
    `⚡ 本次执行：<b>${input.results.length}</b> 个`,
    `✅ 签到成功：<b>${successful.length}</b> 个`,
    `❌ 签到失败：<b>${failures.length}</b> 个`,
    `⏸ 自动关闭：<b>${inactiveSites}</b> 个`,
    `🎁 本次奖励：${rewardSummary || '无新增奖励'}`,
    '',
    '<b>✅ 成功站点</b>',
    ...successLines,
    ...(failures.length ? ['', '<b>❌ 失败站点</b>', ...failureLines] : []),
    '',
    '<i>由公益站签到台自动推送</i>',
  ].join('\n')
}

function summarizeRewards(results: SummaryResult[]): string {
  const totals = new Map<string, number>()
  for (const result of results) {
    if (result.rewardAmount === null) continue
    totals.set(result.currencySymbol, (totals.get(result.currencySymbol) ?? 0) + result.rewardAmount)
  }
  return [...totals.entries()].map(([symbol, amount]) => `<code>${formatAmount(amount, symbol)}</code>`).join(' · ')
}

function formatAmount(value: number, symbol: string): string {
  const digits = Math.abs(value) < 0.01 && value !== 0 ? 4 : 2
  const amount = Math.abs(value).toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
  return `${value > 0 ? '+' : ''}${formatUnitValue(amount, symbol)}`
}

function formatBalance(value: number, symbol: string): string {
  const amount = value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })
  return formatUnitValue(amount, symbol)
}

function formatUnitValue(value: string, symbol: string) {
  return /^(?:KB|MB|GB|TB|PB)$/i.test(symbol) ? `${value} ${symbol}` : `${symbol}${value}`
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value)).replaceAll('/', '-')
}
