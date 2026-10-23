// Tests for the PostToolUse edit accounting, ported from Coucou's recap.rs
// tests (`file_change`, `line_diff` — MIT © 2026 Louis Raillé).
import { describe, expect, it } from "vitest";
import { fileChange, lineDiff, splitLines } from "../src/main/diff";

describe("splitLines", () => {
  it("splits CRLF text without a trailing empty line", () => {
    expect(splitLines("one\r\ntwo\r\n")).toEqual(["one", "two"]);
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a\n")).toEqual(["a"]);
    expect(splitLines("a")).toEqual(["a"]);
  });
});

describe("lineDiff", () => {
  it("counted through their longest common subsequence", () => {
    expect(lineDiff("", "")).toEqual([0, 0]);
    expect(lineDiff("a\nb\nc", "a\nb\nc")).toEqual([0, 0]);
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([2, 1]); // 'b'→'B' changed, 'd' added
    expect(lineDiff("x", "y")).toEqual([1, 1]);
    expect(lineDiff("a\nb\nc", "")).toEqual([0, 3]);
    expect(lineDiff("", "one\ntwo")).toEqual([2, 0]);
  });

  it("treats edits that changed nothing as no change", () => {
    expect(lineDiff("a", "a")).toEqual([0, 0]);
  });

  it("survives pathological sizes with a fallback", () => {
    const big = Array.from({ length: 5000 }, () => "x" + Math.random() + Math.random() + Math.random()).join("\n");
    const [added, removed] = lineDiff(big, "a");
    expect(added).toBe(1);
    expect(removed).toBe(5000);
  });
});

describe("fileChange", () => {
  it("reads Claude's Edit/MultiEdit/Write payloads and skips other tools", () => {
    const edit = fileChange("Edit", { file_path: "/x", old_string: "a\nb\nc", new_string: "a\nB\nc\nd" });
    expect(edit).toEqual({ path: "/x", added: 2, removed: 1 });

    const multi = fileChange("MultiEdit", {
      file_path: "/m",
      edits: [
        { old_string: "a\nb\nc", new_string: "a\nB\nc\nd" },
        { old_string: "x", new_string: "y" },
      ],
    });
    expect(multi).toEqual({ path: "/m", added: 3, removed: 2 });

    const write = fileChange("Write", { file_path: "/w", content: "one\ntwo\nthree\n" });
    expect(write).toEqual({ path: "/w", added: 3, removed: 0 });

    expect(fileChange("Read", { file_path: "/x" })).toBeNull();
    expect(fileChange("Bash", { command: "ls" })).toBeNull();
    expect(fileChange("Edit", { file_path: "/x", old_string: "a", new_string: "a" })).toBeNull();
    expect(fileChange("Edit", { old_string: "a", new_string: "b" })).toBeNull();
    expect(fileChange("Write", { file_path: "/x", content: "" })).toBeNull();
  });

  it("reports Write content without CRLF artifacts", () => {
    const w = fileChange("Write", { file_path: "/w", content: "a\r\nb\r\n" });
    expect(w).toEqual({ path: "/w", added: 2, removed: 0 });
  });
});
