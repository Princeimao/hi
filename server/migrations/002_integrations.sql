-- Per-user service integration tokens (GitHub, Vercel, Notion, Cal.com).
-- Tokens are stored encrypted at rest (AES-256-GCM, key derived from JWT_SECRET).

CREATE TABLE IF NOT EXISTS integration_tokens (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service text NOT NULL CHECK (service IN ('github','vercel','notion','calcom')),
  token text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, service)
);
