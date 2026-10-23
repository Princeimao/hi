-- Friends: external agents discovered on Agentverse that the user connected
-- with, and the message thread with each of them. Also widens the gateway
-- task kinds with "friend" (delivering user messages to external agents).

CREATE TABLE IF NOT EXISTS friends (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  name TEXT NOT NULL,
  readme TEXT,
  agent_status TEXT NOT NULL DEFAULT 'unknown',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS friends_user_address ON friends (user_id, address);

CREATE TABLE IF NOT EXISTS friend_messages (
  id TEXT PRIMARY KEY,
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'agent')),
  content TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'sent' CHECK (state IN ('sent', 'delivered', 'failed', 'replied')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS friend_messages_friend ON friend_messages (friend_id, created_at);

ALTER TABLE agent_tasks DROP CONSTRAINT agent_tasks_kind_check;
ALTER TABLE agent_tasks
  ADD CONSTRAINT agent_tasks_kind_check
  CHECK (kind IN ('chat', 'research', 'plan', 'memory', 'friend', 'custom'));
