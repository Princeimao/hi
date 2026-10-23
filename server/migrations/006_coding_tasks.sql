-- Remote coding tasks: an Agentverse/uAgents agent asks the desktop island to
-- run a local coding CLI (Claude Code, OpenCode, Antigravity). The old check
-- constraint predates the `friend` and `coding` task kinds.

ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_kind_check;
ALTER TABLE agent_tasks
  ADD CONSTRAINT agent_tasks_kind_check
  CHECK (kind IN ('chat','research','plan','memory','custom','friend','coding'));
