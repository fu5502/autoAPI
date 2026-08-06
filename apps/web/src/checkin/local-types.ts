export interface AppEvent {
  type: 'state_changed' | 'run_started' | 'run_completed' | 'site_result' | 'auth_changed'
  title: string
  message: string
  data?: unknown
  createdAt: string
}
