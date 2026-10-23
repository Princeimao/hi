import React, { useState } from "react";
import JellyRadio from "@/components/JellyRadio";
import type { ApprovalView } from "../api";
import { agentColor, agentName } from "../../main/agents-meta";

/**
 * Claude Code asked a question (AskUserQuestion): not a permission to grant —
 * the picked labels go back and Claude Code takes them as the same input with
 * an `answers` map added. Only Claude Code asks questions this way.
 */
export function QuestionCard({ approval }: { approval: ApprovalView }): React.ReactElement {
  const questions = approval.questions ?? [];
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const label = agentName("claude");

  const ready =
    questions.length > 0 &&
    questions.every((q) => {
      const chosen = picks[q.question] ?? [];
      return q.multiSelect ? chosen.length > 0 : chosen.length === 1;
    });

  const answer = (): void => {
    const answers: Record<string, string | string[]> = {};
    for (const q of questions) {
      const chosen = picks[q.question] ?? [];
      if (q.multiSelect && chosen.length > 0) answers[q.question] = chosen;
      else if (!q.multiSelect && chosen.length === 1) answers[q.question] = chosen[0];
    }
    window.hi.answerQuestion(approval.requestId, answers);
  };

  return (
    <div className="card question" style={{ borderTopColor: agentColor("claude") }}>
      <div className="card-head">
        <span className="card-agent" style={{ color: agentColor("claude") }}>
          {label}
        </span>
        <span className="card-tool">asks</span>
      </div>
      {questions.map((q) => (
        <div className="question" key={q.question}>
          <div className="question-text">{q.question}</div>
          <div className="question-options">
            {!q.multiSelect ? (
              <JellyRadio
                items={q.options.map((o) => o.label)}
                value={(picks[q.question] ?? [])[0]}
                onChange={(value) => setPicks((p) => ({ ...p, [q.question]: [value] }))}
                size="sm"
              />
            ) : (
              q.options.map((o) => {
                const chosen = picks[q.question] ?? [];
                const on = chosen.includes(o.label);
                return (
                  <button
                    key={o.label}
                    className={"option" + (on ? " on" : "")}
                    onClick={() =>
                      setPicks((p) => ({
                        ...p,
                        [q.question]: on
                          ? chosen.filter((x) => x !== o.label)
                          : [...chosen, o.label],
                      }))
                    }
                  >
                    {o.label}
                    {o.description ? <span className="option-desc">{o.description}</span> : null}
                  </button>
                );
              })
            )}
            {q.options.some((o) => o.description) ? (
              <div className="w-full text-[10px] text-neutral-500">
                {q.options.map((o) => (o.description ? `${o.label}: ${o.description}` : null)).filter(Boolean).join(" · ")}
              </div>
            ) : null}
          </div>
        </div>
      ))}
      <div className="card-actions">
        <button className="btn allow" disabled={!ready} onClick={answer}>
          Answer
        </button>
        <button className="btn ghost" onClick={() => window.hi.decline(approval.requestId)}>
          Answer in terminal
        </button>
      </div>
    </div>
  );
}
