import React from "react";
import { motion, AnimatePresence } from "motion/react";
import { Timer as TimerIcon } from "lucide-react";
import { agentColor, agentName } from "../../main/agents-meta";
import type { ApprovalView, SessionView } from "../api";
import { IslandAvatar } from "../components/avatar";
import { dockStore, useDockVersion } from "../dockstore";

const STATUS_GLYPH: Record<string, string> = {
  idle: "",
  thinking: "thinking",
  working: "working",
  question: "—",
  approval: "waits for you",
  finished: "done",
  error: "failed",
  ratelimit: "rate limit",
};

const fmt = (s: number): string => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export function CollapsedIsland({
  sessions,
  pending,
  expanded,
  paused,
}: {
  sessions: SessionView[];
  pending: ApprovalView | null;
  expanded: boolean;
  paused: boolean;
}): React.ReactElement {
  useDockVersion();
  const active = sessions.filter((s) => s.status !== "idle");
  const focus = pending
    ? null
    : active.length > 0
      ? active[active.length - 1]
      : sessions[sessions.length - 1];
  const pausedOrIdle = paused ? "sleeping" : (focus?.status ?? "idle");
  const timerChip = !expanded && (dockStore.timerOn || dockStore.seconds > 0);
  const angry = dockStore.mood === "angry";

  return (
    <div className="collapsed-row" style={{ justifyContent: expanded ? "flex-start" : "center", width: expanded ? undefined : "100%" }}>
      <motion.div
        animate={angry ? { x: [0, -3, 3, -3, 3, 0] } : { x: 0 }}
        transition={angry ? { duration: 0.5 } : undefined}
        className="flex-none"
      >
        <IslandAvatar state={pausedOrIdle} />
      </motion.div>
      <AnimatePresence>
        {timerChip ? (
          <motion.div
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 8 }}
            className="ml-1 flex flex-col gap-0.5"
          >
            <div className="flex items-center gap-1 text-[10px] text-neutral-400">
              <TimerIcon className="h-2.5 w-2.5" /> {fmt(dockStore.seconds)}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      {expanded ? (
        <>
          <div className="collapsed-text">
            <div className="collapsed-title">{focus ? focus.projectName : "Hi"}</div>
            <div className="collapsed-sub">{caption(sessions, pending)}</div>
          </div>
          <div className="collapsed-badge" style={{ background: focus ? agentColor(focus.agent ?? "claude") : undefined }} />
        </>
      ) : null}
    </div>
  );
}

function caption(sessions: SessionView[], pending: ApprovalView | null): string {
  if (pending) return `${pending.tool} waits for your answer`;
  const active = sessions.filter((s) => s.status !== "idle");
  if (active.length === 0) return "No agent sessions";
  const focus = active[active.length - 1];
  const label = focus.agent ? agentName(focus.agent) : "Claude Code";
  return `${label}: ${STATUS_GLYPH[focus.status] ?? focus.status}`;
}
