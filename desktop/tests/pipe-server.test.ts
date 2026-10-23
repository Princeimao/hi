import { describe, expect, it } from "vitest";
import { PermissionBroker, applyActionsToBroker, brokerAnswers, pipeName } from "../src/main/pipe-server";

describe("PermissionBroker", () => {
  it("the decision is delivered to the one waiting connection", () => {
    const broker = new PermissionBroker();
    let got: "allow" | "deny" | { answers: Record<string, string | string[]> } | null | undefined;
    const release = broker.wait("r1", (d) => (got = d));
    broker.ack("r1");
    broker.decide("r1", { word: "allow" });
    expect(got).toEqual({ word: "allow" });
    release();
  });

  it("an unacked request is released after the 800 ms ack window", async () => {
    const broker = new PermissionBroker();
    let got: null | undefined = undefined;
    broker.wait("r2", (d) => (got = d));
    await new Promise((r) => setTimeout(r, 900));
    expect(got).toBeNull();
  });

  it("a decision never arrives twice, and a closed connection releases", () => {
    const broker = new PermissionBroker();
    let calls = 0;
    const release = broker.wait("r3", () => calls++);
    release();
    release();
    expect(calls).toBe(1);
  });

  it("decline releases with null, so silence — the terminal asks", () => {
    const broker = new PermissionBroker();
    let got: null | undefined;
    broker.wait("r4", (d) => (got = d));
    broker.decide("r4", null as never);
    expect(got).toBeNull();
  });

  it("brokerAnswers carries the answers map for the CLI's pairing", () => {
    const broker = new PermissionBroker();
    let got: { answers: Record<string, string> } | null | undefined;
    broker.wait("r5", (d) => (got = d));
    brokerAnswers(broker, "r5", { Q: "a" });
    expect(got).toEqual({ answers: { Q: "a" } });
  });

  it("clear() releases everything (quit path)", () => {
    const broker = new PermissionBroker();
    let calls = 0;
    broker.wait("r6", () => calls++);
    broker.clear();
    expect(calls).toBe(1);
  });
});

describe("actions → broker wiring", () => {
  it("reply.answer writes the bare word; reply.decline clears the wait", () => {
    const broker = new PermissionBroker();
    let allow: unknown;
    let deny: unknown;
    broker.wait("a1", (d) => (allow = d));
    broker.wait("a2", (d) => (deny = d));
    applyActionsToBroker(broker, [
      { type: "reply.answer", requestId: "a1", decision: "allow" },
      { type: "reply.decline", requestId: "a2" },
      { type: "session.updated", session: { id: "x", agent: null, sessionId: "", projectName: "", cwd: "", status: "idle", steps: [], finalLine: null, updatedAt: 0 } },
    ]);
    expect(allow).toEqual({ word: "allow" });
    expect(deny).toBeNull();
  });

  it("a question's answers are routed apart from the word replies", () => {
    const broker = new PermissionBroker();
    let got: unknown;
    broker.wait("b1", (d) => (got = d));
    brokerAnswers(broker, "b1", { Q: ["a", "b"] });
    expect(got).toEqual({ answers: { Q: ["a", "b"] } });
  });
});

describe("pipe naming", () => {
  it("the pipe is Hi's and user-namespaced", () => {
    const name = pipeName();
    expect(name).toContain("\\\\.\\pipe\\hi-");
    expect(name.length).toBeGreaterThan("\\\\.\\pipe\\hi-".length);
  });
});
