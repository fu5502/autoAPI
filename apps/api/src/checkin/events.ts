import type { ServerResponse } from 'node:http'

export interface AppEvent {
  type: 'state_changed' | 'run_started' | 'run_completed' | 'site_result' | 'auth_changed'
  title: string
  message: string
  data?: unknown
  createdAt: string
}

export class EventBus {
  private readonly clients = new Set<ServerResponse>()

  subscribe(response: ServerResponse) {
    this.clients.add(response)
    response.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`)
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 25_000)
    response.on('close', () => {
      clearInterval(heartbeat)
      this.clients.delete(response)
    })
  }

  emit(event: Omit<AppEvent, 'createdAt'>) {
    const payload: AppEvent = { ...event, createdAt: new Date().toISOString() }
    const serialized = `event: app_event\ndata: ${JSON.stringify(payload)}\n\n`
    for (const response of this.clients) response.write(serialized)
  }
}
