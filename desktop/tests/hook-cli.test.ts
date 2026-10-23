import { describe, expect, it } from "vitest";
import { parseHookArgs, readStdin } from "../src/main/hook-cli";

// Simulate stdin by swapping process.stdin with a fake readable that emits
// the given chunks, then optionally ends. `endAfterMs` controls whether the
// stream ends (clean) or we rely on readStdin's internal timeout (partial).
function withStdin(chunks: Buffer[], opts: { end: boolean }, fn: () => Promise<void>): Promise<void> {
  const real = process.stdin;
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = { data: [], end: [], error: [] };
  const fake = {
    on(ev: string, cb: (...a: unknown[]) => void) {
      (listeners[ev] ||= []).push(cb);
      return fake;
    },
    destroy() {},
  } as unknown as NodeJS.ReadStream;
  Object.defineProperty(process, "stdin", { value: fake, configurable: true });
  const emit = (ev: string, ...args: unknown[]) => (listeners[ev] || []).forEach((cb) => cb(...args));
  // Emit after listeners are registered.
  setImmediate(() => {
    for (const c of chunks) emit("data", c);
    if (opts.end) emit("end");
  });
  return fn().finally(() => {
    Object.defineProperty(process, "stdin", { value: real, configurable: true });
  });
}

describe("parseHookArgs", () => {
  it("parses --hook <event> --agent <name>", () => {
    const a = parseHookArgs(["--hook", "SessionStart", "--agent", "opencode"]);
    expect(a).toMatchObject({ event: "SessionStart", agent: "opencode", statusline: false });
  });

  it("returns null when --hook is absent", () => {
    expect(parseHookArgs(["--agent", "opencode"])).toBeNull();
  });

  it("strips a leading -- from the event name", () => {
    const a = parseHookArgs(["--hook", "--Stop"]);
    expect(a?.event).toBe("Stop");
  });

  it("detects --statusline", () => {
    const a = parseHookArgs(["--hook", "StatusLine", "--statusline"]);
    expect(a?.statusline).toBe(true);
  });
});

describe("readStdin", () => {
  it("parses a single complete newline-terminated JSON line", async () => {
    await withStdin([Buffer.from('{"a":1}\n')], { end: true }, async () => {
      const out = await readStdin(1 << 20);
      expect(out).toEqual({ a: 1 });
    });
  });

  it("ignores everything after the first newline", async () => {
    await withStdin([Buffer.from('{"a":1}\n{"b":2}\n')], { end: true }, async () => {
      const out = await readStdin(1 << 20);
      expect(out).toEqual({ a: 1 });
    });
  });

  it("returns null for an incomplete body that times out (no newline, no end)", async () => {
    // Partial JSON, stream never ends: readStdin's 1s timeout must NOT parse it.
    await withStdin([Buffer.from('{"a":')], { end: false }, async () => {
      const out = await readStdin(1 << 20);
      expect(out).toBeNull();
    });
  });

  it("returns null for an empty stream", async () => {
    await withStdin([], { end: true }, async () => {
      const out = await readStdin(1 << 20);
      expect(out).toBeNull();
    });
  });

  it("returns null for a non-object JSON body", async () => {
    await withStdin([Buffer.from('[1,2]\n')], { end: true }, async () => {
      const out = await readStdin(1 << 20);
      expect(out).toBeNull();
    });
  });

  it("returns null for malformed JSON", async () => {
    await withStdin([Buffer.from('not-json\n')], { end: true }, async () => {
      const out = await readStdin(1 << 20);
      expect(out).toBeNull();
    });
  });
});
