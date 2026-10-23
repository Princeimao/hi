import React, { useState } from "react";
import type { ApprovalView } from "../api";
import { agentColor, agentName } from "../../main/agents-meta";
import { dockStore } from "../dockstore";

/**
 * The real permission card: what it shows is what gets approved — the
 * identifying string of the exact tool call, not just the tool's name. It is
 * mounted only when `pending` is the live request, so ack means the card is
 * really on screen (the same contract the island's relay waits for).
 */
export function ApprovalCard({ approval }: { approval: ApprovalView }): React.ReactElement {
  const [acked, setAcked] = useState(false);
  useEffectAck(approval, acked);

  const label = approval.pillId.startsWith("agent_")
    ? agentName(approval.pillId.slice("agent_".length))
    : "Claude Code";
  const color = approval.pillId.startsWith("agent_")
    ? agentColor(approval.pillId.slice("agent_".length))
    : agentColor("claude");

  return (
    <div className="card approval" style={{ borderTopColor: color }}>
      <div className="card-head">
        <span className="card-agent" style={{ color }}>
          {label}
        </span>
        <span className="card-tool">{approval.tool}</span>
      </div>
      <div className="card-command">{approval.command}</div>
      {!acked ? <div className="card-note">connecting…</div> : null}
      <div className="card-actions">
        <button className="btn allow" disabled={!acked} onClick={() => window.hi.answer(approval.requestId, "allow")}>
          Allow
        </button>
        <button className="btn deny" disabled={!acked} onClick={() => { dockStore.setMood("angry", 4000); window.hi.answer(approval.requestId, "deny"); }}>
          Deny
        </button>
      </div>
    </div>
  );
}

/// The relay's ack window is 800 ms, so everything on the card is already
/// rendered by the time the first paint lands; acking is one synchronous send
/// after mount.
function useEffectAck(approval: ApprovalView, _acked: boolean): void {
  React.useEffect(() => {
    window.hi.ack(approval.requestId);
  }, [approval.requestId]);
}
