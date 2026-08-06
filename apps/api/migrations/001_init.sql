CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS admin_accounts (
  id integer PRIMARY KEY CHECK (id = 1),
  username text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_login_history (
  id bigserial PRIMARY KEY,
  username text NOT NULL,
  ip inet NOT NULL,
  user_agent text NOT NULL DEFAULT 'unknown',
  success boolean NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_login_history_created ON admin_login_history (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS gateway_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  key_last4 varchar(4) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_gateway_keys_active ON gateway_keys (key_hash) WHERE enabled = true;

CREATE TABLE IF NOT EXISTS providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  website text,
  tags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  key_ciphertext text NOT NULL,
  key_last4 varchar(4) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz
);

ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS key_name text NOT NULL DEFAULT 'API Key';

CREATE TABLE IF NOT EXISTS channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  credential_id uuid NOT NULL REFERENCES provider_credentials(id) ON DELETE RESTRICT,
  name text NOT NULL,
  base_url text NOT NULL,
  favicon_url text,
  protocol text NOT NULL CHECK (protocol IN ('auto', 'openai', 'claude', 'gemini', 'new-api', 'sub2api')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'healthy', 'degraded', 'isolated', 'disabled')),
  enabled boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 0,
  weight integer NOT NULL DEFAULT 100 CHECK (weight > 0),
  min_balance numeric(18, 6),
  current_balance numeric(18, 6),
  balance_currency text,
  balance_status text NOT NULL DEFAULT 'unknown' CHECK (balance_status IN ('ok', 'low', 'exhausted', 'unknown', 'error')),
  consecutive_failures integer NOT NULL DEFAULT 0,
  cooldown_until timestamptz,
  isolation_reason text,
  last_checked_at timestamptz,
  last_latency_ms integer,
  available_models text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE channels ADD COLUMN IF NOT EXISTS favicon_url text;

CREATE TABLE IF NOT EXISTS model_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alias text NOT NULL,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  upstream_model text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (alias, channel_id, upstream_model)
);

CREATE TABLE IF NOT EXISTS health_checks (
  id bigserial PRIMARY KEY,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  ok boolean NOT NULL,
  latency_ms integer NOT NULL,
  models_ok boolean NOT NULL DEFAULT false,
  chat_ok boolean NOT NULL DEFAULT false,
  stream_ok boolean NOT NULL DEFAULT false,
  error text,
  checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_events (
  id bigserial PRIMARY KEY,
  request_id uuid NOT NULL,
  channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  model_alias text NOT NULL,
  upstream_model text,
  client_name text NOT NULL,
  request_kind text NOT NULL,
  status_code integer NOT NULL,
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL,
  error_type text,
  retry_count integer NOT NULL DEFAULT 0,
  streamed boolean NOT NULL DEFAULT false,
  endpoint text,
  source_ip inet,
  gateway_key_name text,
  reasoning_effort text,
  cached_tokens integer,
  cost_usd numeric(18, 8),
  first_byte_latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS endpoint text;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS source_ip inet;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS gateway_key_name text;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS reasoning_effort text;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS cached_tokens integer;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS cost_usd numeric(18, 8);
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS first_byte_latency_ms integer;

CREATE TABLE IF NOT EXISTS balance_snapshots (
  id bigserial PRIMARY KEY,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  balance numeric(18, 6),
  currency text,
  status text NOT NULL CHECK (status IN ('ok', 'low', 'exhausted', 'unknown', 'error')),
  expires_at timestamptz,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS playground_sessions (
  id uuid PRIMARY KEY,
  channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  channel_name text NOT NULL,
  provider_name text NOT NULL,
  model text NOT NULL,
  temperature numeric(5, 3),
  top_p numeric(5, 3),
  max_tokens integer,
  frequency_penalty numeric(5, 3),
  presence_penalty numeric(5, 3),
  stream boolean NOT NULL DEFAULT true,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE playground_sessions ADD COLUMN IF NOT EXISTS stream boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_model_aliases_routing
  ON model_aliases (alias, channel_id) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_channels_health
  ON channels (enabled, status, cooldown_until) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_usage_events_created_at
  ON usage_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_model_created
  ON usage_events (model_alias, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_channel_created
  ON usage_events (channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_health_checks_channel_checked
  ON health_checks (channel_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_balance_snapshots_channel_fetched
  ON balance_snapshots (channel_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_playground_sessions_updated
  ON playground_sessions (updated_at DESC);
