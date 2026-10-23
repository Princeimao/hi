import React, { useEffect, useState } from "react";
import type { PreviewPlan, SettingsStatus } from "../api";

/**
 * Settings → Agents. Nothing writes before the diff: preview → confirm →
 * apply, and only what was looked at is written (config-file.ts fingerprints
 * the bytes, so a settings file that changed in between is refused).
 */
export function AgentsSettings(): React.ReactElement {
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ agent: string; install: boolean; plan: PreviewPlan } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    void window.hi.status().then(setStatus);
  }, [result]);

  const previewAction = async (agent: string, install: boolean): Promise<void> => {
    setError(null);
    setPlan(null);
    const reply = await window.hi.preview(agent, install);
    if (!reply.ok || !reply.plan) {
      setError(reply.error ?? "Unknown error");
      return;
    }
    setPlan({ agent, install, plan: reply.plan });
  };

  const confirmRun = async (): Promise<void> => {
    if (!plan) return;
    setBusy(plan.agent);
    const reply = await window.hi.apply(plan.agent, plan.install, plan.plan.fingerprints);
    setBusy(null);
    if (!reply.ok) {
      setError(reply.error ?? "Unknown error");
    } else {
      setResult(reply.backups || plan.install ? "Installed — restart the agent to pick the hooks up." : "Removed");
      if (!plan.install) setResult("Removed");
    }
    setPlan(null);
  };

  if (!status) return <div className="panel">Loading…</div>;

  const all = [{ id: "claude", name: "Claude Code", installed: status.claude.installed, approvals: true }, ...status.agents];

  return (
    <div className="settings">
      <div className="settings-head">
        <div className="settings-title">Agents</div>
        <div className="settings-sub">{status.claude.settingsPath}</div>
        {!status.claude.hookReady ? <div className="settings-warn">Hook launcher not ready — restart the app.</div> : null}
      </div>
      {all.map((agent) => (
        <div className="agent-row" key={agent.id}>
          <div>
            <div className="agent-name">{agent.name}</div>
            {agent.approvals ? <div className="agent-tag">approvals supported</div> : null}
          </div>
          <div className="agent-actions">
            {agent.installed ? (
              <button className="btn ghost" disabled={busy === agent.id} onClick={() => void previewAction(agent.id, false)}>
                Remove
              </button>
            ) : (
              <button className="btn" disabled={busy === agent.id} onClick={() => void previewAction(agent.id, true)}>
                Install
              </button>
            )}
          </div>
        </div>
      ))}
      {error ? <div className="settings-error">{error}</div> : null}
      {result ? <div className="settings-note">{result}</div> : null}
      {plan ? (
        <div className="diff-box">
          <div className="diff-title">
            {plan.install ? "Install" : "Remove"} · {plan.plan.path}
          </div>
          <pre className="diff">{plan.plan.diff}</pre>
          <div className="diff-note">A dated backup is taken; a file that changed since this preview is refused.</div>
          <div className="card-actions">
            <button className="btn allow" onClick={() => void confirmRun()} disabled={busy !== null}>
              Confirm
            </button>
            <button className="btn ghost" onClick={() => setPlan(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
