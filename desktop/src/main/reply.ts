// Port of mu/windows/hook/src/reply.rs — what Hi prints back to the agent: the
// only place that knows each agent's stdout contract.
//
// The one rule that matters: nothing that allows anything is ever printed
// without a decision a human clicked. With no decision the reply is silence, an
// empty `{}`, or Copilot's explicit "ask", and every agent then asks in its own
// terminal exactly as if Hi were not installed.

export function takesDecisions(agent: string): boolean {
  return (
    agent === "" || agent === "codex" || agent === "copilot" || agent === "muse" || agent === "opencode"
  );
}

/// Agents that read a JSON object on stdout after every hook and get `{}` —
/// "no opinion" — when there is nothing to say.
function wantsJson(agent: string): boolean {
  return agent === "gemini" || agent === "antigravity" || agent === "copilot" || agent === "muse";
}

function stableStringify(value: unknown): string {
  // Deterministic enough for the tests: key order of insertion matches the
  // Rust json! macro output shape closely enough for contract tests via parse.
  return JSON.stringify(value);
}

/// The line to print for `event` from `agent`, given the decision (`null`:
/// nobody clicked) and, for Claude Code's AskUserQuestion, the question as it
/// was asked.
export function hookStdout(
  agent: string,
  event: string,
  decision: string | null,
  question: Record<string, unknown> | null,
): string | null {
  if (event === "PermissionRequest") return permissionStdout(agent, decision, question);
  // Antigravity reads "{}" on PreToolUse as a denial. "ask" keeps its own prompt
  // (and the user's Always Allow): Hi never allows a tool by itself.
  if (agent.toLowerCase() === "antigravity" && event === "PreToolUse") return '{"decision":"ask"}';
  return wantsJson(agent) ? "{}" : null;
}

function permissionStdout(
  agent: string,
  decision: string | null,
  question: Record<string, unknown> | null,
): string | null {
  decision = decision && takesDecisions(agent) ? decision : null;
  // OpenCode's plugin permission hook reads {"status": "allow" | "deny"}.
  if (agent === "opencode") {
    const d = decision?.trim();
    if (d === "allow" || d === "always") return stableStringify({ status: "allow" });
    if (d === "deny") return stableStringify({ status: "deny" });
    return null; // silence → OpenCode asks in its own UI
  }
  // Copilot CLI and Muse Code read a bare permissionDecision. Copilot is
  // fail-closed: it must always get valid JSON, so silence is an "ask".
  if (agent === "copilot" || agent === "muse") {
    const d = decision?.trim();
    const word = d === "allow" || d === "always" ? "allow" : d === "deny" ? "deny" : null;
    if (word) return stableStringify({ permissionDecision: word });
    if (agent === "copilot") return stableStringify({ permissionDecision: "ask" });
    return null;
  }
  // Claude Code and Codex share the documented hookSpecificOutput. Only
  // Claude Code asks questions.
  if (agent === "") return decision ? decisionJson(decision, question) : null;
  return decision ? decisionJson(decision, null) : null;
}

/// The documented PermissionRequest output. Anything we do not recognise prints
/// nothing at all rather than guessing — silence is the safe answer.
/// See https://code.claude.com/docs/en/hooks
///
/// `question` is the AskUserQuestion input, when that is what is being asked:
/// the island may then answer it, which Claude Code takes as the same input
/// with an `answers` map added. Nothing else of the input can be changed from
/// the island, and no other tool's input can be changed at all.
export function decisionJson(
  decision: string,
  question: Record<string, unknown> | null,
): string | null {
  const trimmed = decision.trimStart();
  if (trimmed.startsWith("{")) {
    let reply: Record<string, unknown> | null = null;
    try {
      reply = JSON.parse(decision) as Record<string, unknown>;
    } catch {
      return null;
    }
    const answers = asObject(reply?.["answers"]);
    if (!answers || !question) return null;
    if (!answersFit(question, answers)) return null;
    const input: Record<string, unknown> = { ...question };
    input["answers"] = answers;
    return stableStringify({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: input } },
    });
  }
  const d = decision.trim();
  // "always" still answers a plain allow; remembering it is the island's
  // business, not the agent's.
  let behavior: string | null = null;
  if (d === "allow" || d === "always") behavior = '{"behavior":"allow"}';
  else if (d === "deny") behavior = '{"behavior":"deny","message":"Denied from Hi"}';
  else return null;
  return `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":${behavior}}}`;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/// True when `answers` answers exactly the questions Claude Code asked: one
/// entry per question, keyed by its text; a single-select answer is one of its
/// option labels (a string), a multi-select answer a non-empty list of distinct
/// labels. Same rule as `QuestionPayload.accepts` on macOS.
export function answersFit(
  question: Record<string, unknown>,
  answers: Record<string, unknown>,
): boolean {
  if (!Array.isArray(question["questions"])) return false;
  const list = question["questions"] as Record<string, unknown>[];
  if (list.length === 0 || list.length !== Object.keys(answers).length) return false;
  return list.every((item) => {
    const q = asObject(item);
    if (!q) return false;
    const text = typeof q["question"] === "string" ? q["question"] : null;
    if (!text) return false;
    const options = Array.isArray(q["options"]) ? q["options"] : [];
    const labels = options
      .map((o) => (asObject(o)?.["label"]))
      .filter((l): l is string => typeof l === "string");
    const multi = q["multiSelect"] === true;
    const answer = answers[text];
    if (!multi && typeof answer === "string") return labels.includes(answer);
    if (multi && Array.isArray(answer)) {
      const picks = answer.filter((p): p is string => typeof p === "string");
      const set = Array.from(new Set(picks));
      return picks.length > 0 && set.length === picks.length && picks.every((p) => labels.includes(p));
    }
    return false;
  });
}
