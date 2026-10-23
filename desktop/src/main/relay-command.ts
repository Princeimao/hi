// Port of mu/windows/src-tauri/src/agents.rs "The relay command line" — the
// relay followed by args, as one command line for the shell that runs it.

/// The shell an agent runs its hook commands through on Windows. On Linux every
/// agent uses `sh` (or bash), so there is only one way to quote.
export type Shell = "sh" | "powershell" | "cmd";

export class Relay {
  constructor(
    public exe: string,
    public windows: boolean,
  ) {}

  /// The relay followed by `args`, as one command line for `shell`.
  command(shell: Shell, args: string): string {
    if (!this.windows) return `${shQuote(this.exe)} ${args}`;
    const exe =
      shell === "sh"
        ? // Git Bash reads backslashes as escapes: forward slashes, quoted.
          `"${this.exe.replace(/\\/g, "/")}"`
        : shell === "powershell"
          ? // A quoted string alone is an expression in PowerShell: `&` runs it.
            // Inside single quotes only `'` is special, and it doubles.
            `& '${this.exe.replace(/'/g, "''")}'`
          : // cmd /C keeps the quotes of a lone quoted program name; a plain
            // path goes unquoted so it also works if the agent turns out to
            // use PowerShell.
            isPlain(this.exe)
            ? this.exe
            : `"${this.exe}"`;
    return `${exe} ${args}`;
  }
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/// A path no Windows shell would split or interpret.
function isPlain(p: string): boolean {
  return [...p].every((c) => /[A-Za-z0-9\\:._-]/.test(c));
}

export const quoteFor = { shQuote, isPlain };
