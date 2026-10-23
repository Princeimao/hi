-- Hi — initial schema: users, auth, devices, chats, memories, agents, activity, notifications.

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  asi_model text NOT NULL DEFAULT 'asi1',
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  device_id uuid,
  device_label text NOT NULL DEFAULT '',
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('desktop','mobile','agent')),
  name text NOT NULL DEFAULT '',
  expo_push_token text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  cursor bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS devices_user_idx ON devices(user_id);

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New conversation',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  archived boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations(user_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  seq bigserial PRIMARY KEY,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_message_id text,
  role text NOT NULL CHECK (role IN ('user','assistant','system')),
  content text NOT NULL DEFAULT '',
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, client_message_id)
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, seq);
CREATE INDEX IF NOT EXISTS messages_user_idx ON messages(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'fact' CHECK (kind IN ('fact','preference','goal','person','routine','project')),
  content text NOT NULL,
  source_conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  confidence smallint NOT NULL DEFAULT 60,
  importance smallint NOT NULL DEFAULT 3,
  use_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  content_hash text NOT NULL,
  user_frozen boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS memories_user_idx ON memories(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS memories_hash_idx ON memories(user_id, content_hash);
CREATE INDEX IF NOT EXISTS memories_fts_idx ON memories
  USING gin (to_tsvector('english', content));

CREATE TABLE IF NOT EXISTS agent_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'custom' CHECK (kind IN ('chat','research','plan','memory','custom')),
  title text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','waiting_input','completed','failed','cancelled')),
  agent text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  error text,
  progress smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_tasks_user_idx ON agent_tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_tasks_pending_idx ON agent_tasks(status, created_at)
  WHERE status IN ('queued','running','waiting_input');

CREATE TABLE IF NOT EXISTS agent_activity (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id uuid REFERENCES agent_tasks(id) ON DELETE CASCADE,
  agent text NOT NULL DEFAULT 'system',
  level text NOT NULL DEFAULT 'info' CHECK (level IN ('info','warn','error')),
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_activity_user_idx ON agent_activity(user_id, id DESC);

-- Persisted per-user event stream. Clients remember the last id they saw and
-- replay everything newer after a reconnect — cross-device event persistence.
CREATE TABLE IF NOT EXISTS user_events (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_events_user_idx ON user_events(user_id, id);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'info',
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  task_id uuid REFERENCES agent_tasks(id) ON DELETE SET NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);
