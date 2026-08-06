import type { AppSettings } from './types.js'

export const savedTelegramTokenPlaceholder = '********（已安全保存）'

export function settingsForClient(settings: AppSettings): AppSettings {
  return {
    ...settings,
    telegramBotToken: settings.telegramBotToken ? savedTelegramTokenPlaceholder : '',
  }
}

export function resolveTelegramToken(input: string | undefined, currentToken: string): string | undefined {
  return input === savedTelegramTokenPlaceholder ? currentToken : input
}
