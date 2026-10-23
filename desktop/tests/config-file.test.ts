import { afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  apply,
  backupPath,
  fingerprint,
  pretty,
  preview,
  tryParse,
  type FileEdit,
} from "../src/main/config-file";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hi-cfg-"));
});

afterAll(() => {
  void home;
});

const article = (bytes: Buffer | null): FileEdit["edit"] =>
  ((context) => {
    const parsed = tryParse(context.bytes) ?? { title: "new" };
    return { value: pretty({ ...parsed, seen: 1 }) };
  }) as FileEdit["edit"];

describe("config-file", () => {
  it("fingerprint distinguishes content, absent file and BOM twin", () => {
    const file = path.join(home, "a.json");
    fs.writeFileSync(file, '{"title":"x"}\n', "utf8");
    const bytes = fs.readFileSync(file);
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
    expect(fingerprint(bytes)).not.toBe(fingerprint(bom));
    expect(fingerprint(bytes)).not.toBe(fingerprint(null));
    expect(fingerprint(bytes)).toBe(fingerprint(fs.readFileSync(file)));
  });

  it("tryParse strips the PowerShell BOM", () => {
    const file = path.join(home, "b.json");
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]));
    const parsed = tryParse(fs.readFileSync(file));
    expect(parsed).toEqual({ a: 1 });
  });

  it("backupPath is dated and next to the file", () => {
    const stamp = backupPath(path.join(home, "s.json"), new Date(2026, 0, 2, 3, 4, 5, 6));
    expect(stamp).toContain("s.json.2026-");
    expect(stamp.endsWith(".backup")).toBe(true);
  });

  it("preview surfaces the diff and refuses files that are not JSON", () => {
    const file = path.join(home, "c.json");
    fs.writeFileSync(file, "not json", "utf8");
    const edits: FileEdit[] = [
      {
        path: file,
        edit: (ctx) =>
          ctx.parsed === null && ctx.bytes !== null ? { error: "could not parse" } : { value: "{}\n" },
      },
    ];
    expect(() => preview(edits)).toThrow("could not parse");
  });

  it("apply takes a dated backup first and writes the merged content", () => {
    const file = path.join(home, "d.json");
    fs.writeFileSync(file, '{"keep":true}', "utf8");
    const before = fs.readFileSync(file);
    const edits: FileEdit[] = [{ path: file, edit: () => ({ value: '{"keep":true,"hi":true}\n' }) }];
    const plan = preview(edits);
    const backups = apply(edits, plan.fingerprint);
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(backups[0]).equals(before)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ keep: true, hi: true });
  });

  it("apply refuses when the file changed since the preview — nothing is written", () => {
    const file = path.join(home, "e.json");
    fs.writeFileSync(file, '{"n":1}', "utf8");
    const edits: FileEdit[] = [{ path: file, edit: () => ({ value: '{"n":2}' }) }];
    const plan = preview(edits);
    fs.writeFileSync(file, '{"n":999}', "utf8");
    expect(() => apply(edits, plan.fingerprint)).toThrow(/changed since the preview/);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ n: 999 });
  });

  it("a null value removes the file (and nothing else)", () => {
    const file = path.join(home, "f.json");
    fs.writeFileSync(file, "{}", "utf8");
    const edits: FileEdit[] = [{ path: file, edit: () => ({ value: null }) }];
    const plan = preview(edits);
    apply(edits, plan.fingerprint);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("fingerprint(null) equals the same, so install into nothing is allowed once", () => {
    expect(fingerprint(null)).toBe(fingerprint(Buffer.alloc(0)));
  });
});
