export interface AppEvent {
  type: 'state_changed' | 'run_started' | 'run_completed' | 'run_progress' | 'site_result' | 'auth_changed'
  title: string
  message: string
  data?: unknown
  createdAt: string
}
