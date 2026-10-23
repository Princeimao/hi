import { describe, expect, it, beforeEach } from "vitest";
import type { Timers } from "../src/main/registry";
import {
  ACK_TIMEOUT_MS,
  CARD_TIMEOUT_MS,
  STOP_TIMER_MS,
  SessionRegistry,
  type RegistryAction,
} from "../src/main/registry";

type Scheduled = { fn: () => void; ms: number; cleared: boolean };

class FakeClock implements Timers {
  queue: Scheduled[] = [];
  setTimeout(fn: () => void, ms: number): unknown {
    const job: Scheduled = { fn, ms, cleared: false };
    this.queue.push(job);
    return job;
  }
  clearTimeout(t: unknown): void {
    (t as Scheduled).cleared = true;
  }
  fire(ms: number): number {
    let fired = 0;
    for (const job of this.queue) {
      if (!job.cleared && job.ms <= ms) {
        job.cleared = true;
        job.fn();
        fired++;
      }
    }
    return fired;
  }
}

const permissionRequest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  hook_event_name: "PermissionRequest",
  request_id: "r1",
  session_id: "s1",
  cwd: "E:\\Projects\\demo",
  tool_name: "Bash",
  tool_input: { command: "npm install" },
  ...over,
});

function setup(): { registry: SessionRegistry; clock: FakeClock; actions: RegistryAction[][] } {
  const clock = new FakeClock();
  const actions: RegistryAction[][] = [];
  const registry = new SessionRegistry((batch) => actions.push(batch), clock);
  return { registry, clock, actions };
}

describe("SessionRegistry — sessions and steps", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => (h = setup()));

  it("a SessionStart creates the Claude Code pill; fresh sessions list", () => {
    h.registry.ingest({ hook_event_name: "SessionStart", session_id: "s1", cwd: "E:\\Projects\\demo" });
    expect(h.registry.snapshot().sessions).toHaveLength(1);
    const s = h.registry.snapshot().sessions[0];
    expect(s.id).toBe("claude");
    expect(s.projectName).toBe("demo");
    expect(s.status).toBe("idle");
  });

  it("NonItem updates carry tool steps and the working status", () => {
    h.registry.ingest({ hook_event_name: "SessionStart", session_id: "s1", cwd: "E:\\Projects\\demo" });
    h.registry.ingest({ hook_event_name: "PreToolUse", session_id: "s1", cwd: "E:\\Projects\\demo", tool_name: "Bash", tool_input: { command: "git status" } });
    const s = h.registry.snapshot().sessions[0];
    expect(s.status).toBe("working");
    expect(s.steps[0]).toContain("Runs");
    expect(s.steps[0]).toContain("git status");
  });

  it("Stop marks finished, then the pill goes idle after the stop timer", () => {
    h.registry.ingest({ hook_event_name: "SessionStart", session_id: "s1", cwd: "E:\\Projects\\demo" });
    h.registry.ingest({ hook_event_name: "Stop", session_id: "s1", cwd: "E:\\Projects\\demo", last_assistant_message: "Done.\nSecond line." });
    expect(h.registry.snapshot().sessions[0].status).toBe("finished");
    expect(h.registry.snapshot().sessions[0].finalLine).toBe("Done. Second line.");
    h.clock.fire(STOP_TIMER_MS + 1);
    expect(h.registry.snapshot().sessions[0].status).toBe("idle");
  });

  it("an errored stop shows status error (relay already refined the event)", () => {
    h.registry.ingest({ hook_event_name: "SessionStart", session_id: "s1", cwd: "E:\\P\\demo" });
    h.registry.ingest({ hook_event_name: "StopFailure", session_id: "s1", cwd: "E:\\P\\demo" });
    expect(h.registry.snapshot().sessions[0].status).toBe("error");
  });

  it("SessionEnd resets the Claude Code pill and drops external agents", () => {
    h.registry.ingest({ hook_event_name: "SessionStart", session_id: "s1", cwd: "E:\\P\\demo" });
    h.registry.ingest({ hook_event_name: "SessionEnd", session_id: "s1", cwd: "E:\\P\\demo" });
    const s = h.registry.snapshot().sessions[0];
    expect(s.status).toBe("idle");
    expect(s.steps).toHaveLength(0);

    h.registry.ingest({ hook_event_name: "SessionStart", session_id: "s2", cwd: "D:\\w", hi_agent: "codex" });
    expect(h.registry.snapshot().sessions.some((x) => x.id === "agent_codex")).toBe(true);
    h.registry.ingest({ hook_event_name: "SessionEnd", session_id: "s2", cwd: "D:\\w", hi_agent: "codex" });
    expect(h.registry.snapshot().sessions.some((x) => x.id === "agent_codex")).toBe(false);
  });

  it("an external agent session survives Stop and stays visible as idle", () => {
    // Regression: Stop used to delete external sessions after the stop timer,
    // so the island read "No agent sessions" between prompts. Only SessionEnd
    // may remove them now.
    h.registry.ingest({ hook_event_name: "SessionStart", session_id: "s3", cwd: "D:\\w", hi_agent: "opencode" });
    h.registry.ingest({ hook_event_name: "PreToolUse", session_id: "s3", cwd: "D:\\w", hi_agent: "opencode", tool_name: "Bash", tool_input: { command: "ls" } });
    h.registry.ingest({ hook_event_name: "Stop", session_id: "s3", cwd: "D:\\w", hi_agent: "opencode", last_assistant_message: "done" });
    expect(h.registry.snapshot().sessions.some((x) => x.id === "agent_opencode")).toBe(true);
    // Fire the stop timer: the session must still be present, now idle.
    h.clock.fire(STOP_TIMER_MS + 1);
    const s = h.registry.snapshot().sessions.find((x) => x.id === "agent_opencode");
    expect(s).toBeDefined();
    expect(s!.status).toBe("idle");
    // Only SessionEnd removes it.
    h.registry.ingest({ hook_event_name: "SessionEnd", session_id: "s3", cwd: "D:\\w", hi_agent: "opencode" });
    expect(h.registry.snapshot().sessions.some((x) => x.id === "agent_opencode")).toBe(false);
  });

  it("unknown agents are marked by tag and never drive the Claude pill", () => {
    h.registry.ingest({ hook_event_name: "PreToolUse", session_id: "x", cwd: "D:\\w", hi_agent: "gemini", tool_name: "write_file", tool_input: { path: "D:\\w\\a.txt" } });
    const snap = h.registry.snapshot();
    const gem = snap.sessions.find((s) => s.id === "agent_gemini");
    expect(gem).toBeDefined();
    expect(gem!.agent).toBe("gemini");
    expect(snap.sessions.some((s) => s.id === "claude")).toBe(false);
    expect(gem!.steps[0]).toContain("a.txt");
  });
});

describe("SessionRegistry — the approval lifecycle", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => (h = setup()));

  it("PermissionRequest shows one card, and the card timer dismisses it", () => {
    h.registry.ingest(permissionRequest());
    expect(h.registry.pending).not.toBeNull();
    expect(h.actions.some((batch) => batch.some((a) => a.type === "approval.begin"))).toBe(true);
    const session = h.registry.snapshot().sessions[0];
    expect(session.status).toBe("approval");

    h.clock.fire(CARD_TIMEOUT_MS + 1);
    expect(h.registry.pending).toBeNull();
    expect(h.actions.some((batch) => batch.some((a) => a.type === "approval.drop"))).toBe(true);
  });

  it("Allow answers and clears the pending card", () => {
    h.registry.ingest(permissionRequest());
    const { decision, actions } = h.registry.answer("r1", "allow");
    expect(decision).toBe("allow");
    expect(h.registry.pending).toBeNull();
    expect(actions.some((a) => a.type === "reply.answer" && a.decision === "allow")).toBe(true);
  });

  it("only the live request answers; nothing after the card timed out", () => {
    h.registry.ingest(permissionRequest());
    expect(h.registry.answer("other", "allow").decision).toBeNull();

    h.registry.ingest(permissionRequest({ request_id: "r1" }));
    h.clock.fire(CARD_TIMEOUT_MS + 1);
    expect(h.registry.answer("r1", "allow").decision).toBeNull();
  });

  it("a second request does not replace the first; the newcomer is declined", () => {
    h.registry.ingest(permissionRequest({ request_id: "r1" }));
    const out = h.registry.ingest(permissionRequest({ request_id: "r2" }));
    expect(h.registry.pending?.requestId).toBe("r1");
    expect(out.some((a) => a.type === "reply.decline" && a.requestId === "r2")).toBe(true);
  });

  it("agents without decisions get declined at once", () => {
    const out = h.registry.ingest(permissionRequest({ request_id: "r3", hi_agent: "gemini" }));
    expect(h.registry.pending).toBeNull();
    expect(out.some((a) => a.type === "reply.decline")).toBe(true);
  });

  it("turn over (Interrupt / Stop / new prompt) drops the card and declines", () => {
    h.registry.ingest(permissionRequest({ request_id: "r1" }));
    const out = h.registry.ingest({ hook_event_name: "Interrupt", session_id: "s1", cwd: "E:\\Projects\\demo" });
    expect(h.registry.pending).toBeNull();
    expect(out.some((a) => a.type === "reply.decline" && a.requestId === "r1")).toBe(true);
  });

  it("PostToolUse AskUserQuestion means it was answered in the terminal", () => {
    const q = { questions: [{ question: "Q?", options: [{ label: "a" }, { label: "b" }] }] };
    h.registry.ingest(permissionRequest({ request_id: "r1", tool_name: "AskUserQuestion", tool_input: q }));
    expect(h.registry.pending?.questions).not.toBeNull();
    const out = h.registry.ingest({
      hook_event_name: "PostToolUse",
      session_id: "s1",
      cwd: "E:\\Projects\\demo",
      tool_name: "AskUserQuestion",
      tool_input: q,
    });
    expect(h.registry.pending).toBeNull();
    expect(out.some((a) => a.type === "approval.drop")).toBe(true);
  });

  it("ack only covers the live request (broker: 800 ms window — see pipe tests)", () => {
    h.registry.ingest(permissionRequest({ request_id: "r1" }));
    expect(h.registry.ack("r1")).toBe(true);
    expect(h.registry.ack("nope")).toBe(false);
    expect(ACK_TIMEOUT_MS).toBe(800);
  });

  it("answers go back for a question Claude Code asked", () => {
    const q = { questions: [{ question: "Q?", options: [{ label: "a" }, { label: "b" }] }] };
    h.registry.ingest(permissionRequest({ request_id: "r1", tool_name: "AskUserQuestion", tool_input: q }));
    const { answers, actions } = h.registry.answerQuestion("r1", { "Q?": "a" });
    expect(answers).toEqual({ "Q?": "a" });
    expect(h.registry.pending).toBeNull();
    expect(actions.some((a) => a.type === "reply.answer")).toBe(true);
  });

  it("questions are refused on agents that cannot decide (Codex carries no questions)", () => {
    const q = { questions: [{ question: "Q?", options: [{ label: "a" }, { label: "b" }] }] };
    h.registry.ingest(permissionRequest({ request_id: "r1", hi_agent: "codex", tool_name: "AskUserQuestion", tool_input: q }));
    expect(h.registry.pending?.questions).toBeNull();
    expect(h.registry.pending).not.toBeNull();
  });
});

describe("SessionRegistry — pause, decline", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => (h = setup()));

  it("pausing drops the live card; a request while paused is declined", () => {
    h.registry.ingest(permissionRequest({ request_id: "r1" }));
    h.registry.setPaused(true);
    expect(h.registry.pending).toBeNull();
    expect(h.registry.paused).toBe(true);

    const out = h.registry.ingest(permissionRequest({ request_id: "r2" }));
    expect(h.registry.pending).toBeNull();
    expect(out.some((a) => a.type === "reply.decline" && a.requestId === "r2")).toBe(true);

    // Unpausing accepts new cards again.
    h.registry.setPaused(false);
    h.registry.ingest(permissionRequest({ request_id: "r3" }));
    expect(h.registry.pending?.requestId).toBe("r3");
  });

  it("decline drops the card without writing anything back (terminal takes over)", () => {
    h.registry.ingest(permissionRequest({ request_id: "r1" }));
    const { declined, actions } = h.registry.decline("r1");
    expect(declined).toBe(true);
    expect(h.registry.pending).toBeNull();
    expect(actions.some((a) => a.type === "reply.decline")).toBe(true);
    expect(actions.some((a) => a.type === "reply.answer")).toBe(false);
  });

  it("the ratelimit notification shows a ratelimit status", () => {
    h.registry.ingest({ hook_event_name: "SessionStart", session_id: "s1", cwd: "E:\\P\\demo" });
    h.registry.ingest({ hook_event_name: "Notification", session_id: "s1", cwd: "E:\\P\\demo", message: "Rate limit hit" });
    expect(h.registry.snapshot().sessions[0].status).toBe("ratelimit");
  });

  it("Notification ending in ? marks the session as asking", () => {
    h.registry.ingest({ hook_event_name: "SessionStart", session_id: "s1", cwd: "E:\\P\\demo" });
    h.registry.ingest({ hook_event_name: "Notification", session_id: "s1", cwd: "E:\\P\\demo", message: "Shall I proceed?" });
    const s = h.registry.snapshot().sessions[0];
    expect(s.status).toBe("question");
    expect(s.steps.at(-1)).toBe("Shall I proceed?");
  });
});
