// Pi agent runner — spawns the Pi coding agent directly on this machine via
// child_process. Pi has its own model keys (Google auth confirmed) and built-in
// file tools (read, bash, edit, write, grep, find, ls), so it can search,
// read, list and write files without any island round-trip.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const PI_TIMEOUT_MS = 90_000;
const MAX_OUTPUT = 6000;

/**
 * Run one Pi task and return its final assistant text.
 * `cwd` is the working folder (defaults to the user's home).
 */
export async function runPiTask(prompt: string, cwd?: string): Promise<string> {
  const workdir = cwd && cwd.trim() ? cwd.trim() : (process.env["USERPROFILE"] ?? process.env["HOME"] ?? "E:\\");
  const { stdout, stderr } = await execFileP(
    "pi",
    ["--print", "--no-session", "--model", "google/gemini-2.5-flash", "--tools", "read,powershell,edit,write,grep,find,ls", "--", prompt],
    { cwd: workdir, timeout: PI_TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024 },
  );
  const out = (stdout ?? "").trim();
  const err = (stderr ?? "").trim();
  if (!out && err) return `(Pi error: ${err.slice(0, 800)})`;
  return (out || err || "(Pi produced no output)").slice(0, MAX_OUTPUT);
}
