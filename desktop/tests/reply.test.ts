import { describe, expect, it } from "vitest";
import { answersFit, decisionJson, hookStdout, takesDecisions } from "../src/main/reply";

describe("takesDecisions", () => {
  it("Claude Code, Codex, Copilot and Muse may take a decision; nobody else", () => {
    expect(takesDecisions("")).toBe(true);
    expect(takesDecisions("codex")).toBe(true);
    expect(takesDecisions("copilot")).toBe(true);
    expect(takesDecisions("muse")).toBe(true);
    expect(takesDecisions("gemini")).toBe(false);
    expect(takesDecisions("cursor")).toBe(false);
    expect(takesDecisions("antigravity")).toBe(false);
  });
});

describe("hookStdout — PermissionRequest", () => {
  it("prints the documented hookSpecificOutput for Claude Code", () => {
    const out = hookStdout("", "PermissionRequest", "allow", null);
    expect(out).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}',
    );
    const deny = hookStdout("", "PermissionRequest", "deny", null);
    expect(deny).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Hi"}}}',
    );
  });

  it("never prints an allow without a human decision", () => {
    expect(hookStdout("", "PermissionRequest", null, null)).toBeNull();
    expect(hookStdout("", "PermissionRequest", "", null)).toBeNull();
  });

  it("treats 'always' as an allow and ignores unknown words", () => {
    expect(hookStdout("", "PermissionRequest", "always", null)).toContain('"behavior":"allow"');
    expect(hookStdout("", "PermissionRequest", "maybe", null)).toBeNull();
  });

  it("agents outside the decision set never get an allow", () => {
    expect(hookStdout("gemini", "PermissionRequest", "allow", null)).toBeNull();
    expect(hookStdout("copilot", "PermissionRequest", "allow", null)).not.toBeNull();
    expect(hookStdout("muse", "PermissionRequest", "allow", null)).not.toBeNull();
  });

  it("Copilot is fail-closed JSON: ask unless clicked, deny word mapped", () => {
    expect(hookStdout("copilot", "PermissionRequest", null, null)).toBe('{"permissionDecision":"ask"}');
    expect(hookStdout("copilot", "PermissionRequest", "deny", null)).toBe('{"permissionDecision":"deny"}');
    expect(hookStdout("copilot", "PermissionRequest", "junk", null)).toBe('{"permissionDecision":"ask"}');
  });

  it("Muse stays silent when nobody clicked (it is not fail-closed)", () => {
    expect(hookStdout("muse", "PermissionRequest", null, null)).toBeNull();
    expect(hookStdout("muse", "PermissionRequest", "allow", null)).toBe('{"permissionDecision":"allow"}');
  });

  it("Codex uses the same hookSpecificOutput as Claude Code, without questions", () => {
    const q = { questions: [{ question: "Q", options: [{ label: "A" }, { label: "B" }] }] };
    expect(hookStdout("codex", "PermissionRequest", "allow", q)).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}',
    );
  });
});

describe("decisionJson with AskUserQuestion answers", () => {
  const question = {
    questions: [
      { question: "Pick", options: [{ label: "One" }, { label: "Two" }], multiSelect: false },
    ],
  };

  it("pairs the answers with the question and allows the tool with updatedInput", () => {
    const out = decisionJson('{"answers":{"Pick":"One"}}', question);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!) as {
      hookSpecificOutput: { decision: { behavior: string; updatedInput: Record<string, unknown> } };
    };
    expect(parsed.hookSpecificOutput.decision.behavior).toBe("allow");
    expect(parsed.hookSpecificOutput.decision.updatedInput).toEqual({
      questions: question.questions,
      answers: { Pick: "One" },
    });
  });

  it("refuses answers that do not fit the questions", () => {
    expect(decisionJson('{"answers":{"Other":"One"}}', question)).toBeNull();
    expect(decisionJson('{"answers":{"Pick":"Three"}}', question)).toBeNull();
    expect(decisionJson('{"answers":{}}', question)).toBeNull();
    expect(decisionJson('{"answers":{"Pick":"One"}}', null)).toBeNull();
    expect(decisionJson("not json", question)).toBeNull();
    expect(decisionJson('{"answers":{"Pick":["One","Two"]}}', question)).toBeNull();
  });
});

describe("answersFit", () => {
  const multi = {
    questions: [
      { question: "Which", options: [{ label: "A" }, { label: "B" }, { label: "C" }], multiSelect: true },
    ],
  };

  it("multi-select takes any non-empty subset of distinct labels", () => {
    expect(answersFit(multi, { Which: ["A"] })).toBe(true);
    expect(answersFit(multi, { Which: ["A", "C"] })).toBe(true);
    expect(answersFit(multi, { Which: [] })).toBe(false);
    expect(answersFit(multi, { Which: ["A", "A"] })).toBe(false);
    expect(answersFit(multi, { Which: ["A", "Z"] })).toBe(false);
    expect(answersFit(multi, { Which: "A" })).toBe(false);
  });

  it("one entry per question, keyed by the question text", () => {
    const two = {
      questions: [
        { question: "Q1", options: [{ label: "y" }, { label: "n" }], multiSelect: false },
        { question: "Q2", options: [{ label: "1" }, { label: "2" }], multiSelect: false },
      ],
    };
    expect(answersFit(two, { Q1: "y", Q2: "2" })).toBe(true);
    expect(answersFit(two, { Q1: "y" })).toBe(false);
    expect(answersFit(two, { Q1: "y", Q2: "9" })).toBe(false);
  });

  it("a single-select answer must be one of the option labels", () => {
    const single = { questions: [{ question: "Q", options: [{ label: "go" }], multiSelect: false }] };
    expect(answersFit(single, { Q: "go" })).toBe(true);
    expect(answersFit(single, { Q: 42 })).toBe(false);
  });
});

describe("hookStdout — other events", () => {
  it("Antigravity's PreToolUse asks, never allows", () => {
    expect(hookStdout("antigravity", "PreToolUse", null, null)).toBe('{"decision":"ask"}');
  });

  it("JSON-reading agents get {} and the rest get silence", () => {
    expect(hookStdout("gemini", "PostToolUse", null, null)).toBe("{}");
    expect(hookStdout("copilot", "PostToolUse", null, null)).toBe("{}");
    expect(hookStdout("", "PostToolUse", null, null)).toBeNull();
    expect(hookStdout("cursor", "PreToolUse", null, null)).toBeNull();
    expect(hookStdout("antigravity", "PostToolUse", null, null)).toBe("{}");
  });
});
