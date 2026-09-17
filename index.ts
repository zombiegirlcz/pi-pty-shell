/**
 * pi-pty-shell — Full interactive PTY extension for pi
 *
 * Port of gemini-cli's ShellExecutionService PTY logic into a pi extension.
 * Enables running fully interactive TUI applications (vim, htop, nano, etc.)
 * with real terminal access.
 *
 * Two modes:
 *   1. CAPTURE mode (default for pty_exec tool):
 *      Spawns via node-pty, captures output through @xterm/headless,
 *      and renders the result directly in the tool call output window.
 *      No screen flash, output stays visible.
 *
 *   2. HANDOFF mode (for truly interactive apps via !vim, !nano, etc.):
 *      Suspends pi TUI, hands terminal to child process, restores after exit.
 *      Used when the command needs real keyboard input (editors, etc.)
 *
 * Usage:
 *   !vim file.txt          (auto-detected → handoff mode)
 *   !i any-command         (force handoff mode)
 *   !top -n 5              (capture mode — output stays in tool call)
 *   /pty <command>         (capture mode)
 *   pty_exec tool          (LLM agent — capture mode by default)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawnSync } from "node:child_process";
import { Text } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Interactive command detection
// ---------------------------------------------------------------------------

const DEFAULT_INTERACTIVE_COMMANDS = [
  "vim", "nvim", "vi", "nano", "emacs", "pico", "micro", "helix", "hx", "kak",
  "less", "more", "most",
  "git commit", "git rebase", "git merge", "git cherry-pick", "git revert",
  "git add -p", "git add --patch", "git add -i", "git add --interactive",
  "git stash -p", "git stash --patch", "git reset -p", "git reset --patch",
  "git checkout -p", "git checkout --patch", "git difftool", "git mergetool",
  "htop", "top", "btop", "glances",
  "ranger", "nnn", "lf", "mc", "vifm",
  "tig", "lazygit", "gitui",
  "fzf", "sk",
  "ssh", "telnet", "mosh",
  "psql", "mysql", "sqlite3", "mongosh", "redis-cli",
  "kubectl edit", "kubectl exec -it", "docker exec -it", "docker run -it",
  "tmux", "screen", "ncdu",
];

/** Commands that NEED full handoff (real keyboard input required) */
const HANDOFF_ONLY_COMMANDS = new Set([
  "vim", "nvim", "vi", "nano", "emacs", "pico", "micro", "helix", "hx", "kak",
  "ssh", "telnet", "mosh", "tmux", "screen",
  "git rebase", "git commit", "git merge", "git cherry-pick", "git revert",
  "git add -p", "git add --patch", "git add -i", "git add --interactive",
  "git stash -p", "git stash --patch", "git reset -p", "git reset --patch",
  "git checkout -p", "git checkout --patch", "git difftool", "git mergetool",
  "kubectl edit", "kubectl exec -it", "docker exec -it", "docker run -it",
  "ranger", "nnn", "lf", "mc", "vifm", "fzf", "sk",
  "psql", "mysql", "sqlite3", "mongosh", "redis-cli",
]);

function getInteractiveCommands(): string[] {
  const additional =
    process.env.INTERACTIVE_COMMANDS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  const excluded = new Set(
    process.env.INTERACTIVE_EXCLUDE?.split(",").map((s) => s.trim().toLowerCase()) ?? [],
  );
  return [...DEFAULT_INTERACTIVE_COMMANDS, ...additional].filter(
    (cmd) => !excluded.has(cmd.toLowerCase()),
  );
}

function isInteractiveCommand(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  const commands = getInteractiveCommands();
  for (const cmd of commands) {
    const cmdLower = cmd.toLowerCase();
    if (
      trimmed === cmdLower ||
      trimmed.startsWith(`${cmdLower} `) ||
      trimmed.startsWith(`${cmdLower}\t`)
    ) {
      return true;
    }
    const pipeIdx = trimmed.lastIndexOf("|");
    if (pipeIdx !== -1) {
      const afterPipe = trimmed.slice(pipeIdx + 1).trim();
      if (afterPipe === cmdLower || afterPipe.startsWith(`${cmdLower} `)) {
        return true;
      }
    }
  }
  return false;
}

function needsHandoff(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  for (const cmd of HANDOFF_ONLY_COMMANDS) {
    const cmdLower = cmd.toLowerCase();
    if (
      trimmed === cmdLower ||
      trimmed.startsWith(`${cmdLower} `) ||
      trimmed.startsWith(`${cmdLower}\t`)
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// PTY Capture execution (gemini-cli shellExecutionService port)
// Spawns via node-pty, captures through headless terminal, returns output.
// No screen flash — output rendered in tool call result.
// ---------------------------------------------------------------------------

interface PtyCaptureResult {
  exitCode: number | null;
  output: string;
  ansiOutput?: string;
  error?: string;
}

async function runWithPtyCapture(
  command: string,
  opts?: { cwd?: string; timeoutMs?: number; cols?: number; rows?: number },
): Promise<PtyCaptureResult> {
  const cols = opts?.cols ?? process.stdout.columns ?? 80;
  const rows = opts?.rows ?? process.stdout.rows ?? 30;
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const cwd = opts?.cwd ?? process.cwd();

  let pty: any;
  try {
    pty = await import("@lydell/node-pty");
  } catch {
    try {
      pty = await import("node-pty");
    } catch {
      return {
        exitCode: 1,
        output: "(node-pty not available — install @lydell/node-pty)",
        error: "node-pty not found",
      };
    }
  }

  let headlessTerminal: any;
  try {
    const xterm = await import("@xterm/headless");
    headlessTerminal = new xterm.Terminal({
      allowProposedApi: true,
      cols,
      rows,
      scrollback: 5000,
    });
  } catch {
    // Fallback: capture raw text without terminal emulation
    headlessTerminal = null;
  }

  return new Promise<PtyCaptureResult>((resolve) => {
    const shell = process.env.SHELL || "/bin/sh";
    let resolved = false;
    let rawOutput = "";

    const finish = (exitCode: number | null, error?: string) => {
      if (resolved) return;
      resolved = true;

      let output: string;
      let ansiOutput: string | undefined;

      if (headlessTerminal) {
        try {
          const buf = headlessTerminal.buffer.active;
          const lines: string[] = [];
          let lastContent = -1;

          for (let i = buf.length - 1; i >= 0; i--) {
            const line = buf.getLine(i);
            if (line && line.translateToString(true).trim().length > 0) {
              lastContent = i;
              break;
            }
          }

          if (lastContent >= 0) {
            for (let i = 0; i <= lastContent; i++) {
              const line = buf.getLine(i);
              lines.push(line ? line.translateToString(true) : "");
            }
          }

          output = lines.join("\n").trim();

          // Also get ANSI version for rendering
          const ansiLines: string[] = [];
          for (let i = 0; i <= lastContent; i++) {
            const line = buf.getLine(i);
            if (line) {
              let lineStr = "";
              for (let col = 0; col < buf.length; col++) {
                // translateToString with trimRight=false preserves spacing
                lineStr = line.translateToString(false);
                break;
              }
              ansiLines.push(lineStr);
            } else {
              ansiLines.push("");
            }
          }
          ansiOutput = ansiLines.join("\n").trimEnd();
        } catch {
          output = rawOutput;
        }
      } else {
        output = rawOutput;
      }

      try {
        headlessTerminal?.dispose();
      } catch { /* ignore */ }

      resolve({
        exitCode,
        output: output || "(no output)",
        ansiOutput,
        error,
      });
    };

    let ptyProcess: any;
    try {
      ptyProcess = pty.spawn(shell, ["-c", command], {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: { ...process.env, TERM: "xterm-256color" },
      });
    } catch (e: any) {
      finish(1, e.message);
      return;
    }

    const timer = setTimeout(() => {
      try { ptyProcess.kill(); } catch { /* ignore */ }
      finish(null, "timeout");
    }, timeoutMs);

    ptyProcess.onData((data: string) => {
      rawOutput += data;
      if (headlessTerminal) {
        try {
          headlessTerminal.write(data);
        } catch { /* ignore */ }
      }
    });

    ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      clearTimeout(timer);
      // Small delay to let headless terminal process remaining data
      setTimeout(() => {
        finish(exitCode, signal ? `killed by signal ${signal}` : undefined);
      }, 50);
    });
  });
}

// ---------------------------------------------------------------------------
// Full TTY handoff (for truly interactive apps: vim, nano, ssh, etc.)
// ---------------------------------------------------------------------------

interface PtyResult {
  exitCode: number | null;
  output: string;
  error?: string;
}

function runWithFullTty(command: string, tui: any): PtyResult {
  tui.stop();
  process.stdout.write("\x1b[2J\x1b[H");

  const shell = process.env.SHELL || "/bin/sh";
  const result = spawnSync(shell, ["-c", command], {
    stdio: "inherit",
    env: { ...process.env, TERM: "xterm-256color" },
  });

  tui.start();
  tui.requestRender(true);

  return {
    exitCode: result.status,
    output: result.status === 0
      ? "(interactive command completed successfully)"
      : `(interactive command exited with code ${result.status})`,
    error: result.error?.message,
  };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // -----------------------------------------------------------------------
  // 1. Intercept user `!` commands
  // -----------------------------------------------------------------------
  pi.on("user_bash", async (event, ctx) => {
    let command = event.command;
    let forceHandoff = false;

    if (command.startsWith("i ") || command.startsWith("i\t")) {
      forceHandoff = true;
      command = command.slice(2).trim();
    }

    const shouldBeInteractive = forceHandoff || isInteractiveCommand(command);
    if (!shouldBeInteractive) {
      return;
    }

    if (ctx.mode !== "tui") {
      return {
        result: {
          output: "(interactive commands require TUI mode)",
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }

    // Decide: handoff vs capture
    const useHandoff = forceHandoff || needsHandoff(command);

    if (useHandoff) {
      const ptyResult = await ctx.ui.custom<PtyResult>((tui, _theme, _kb, done) => {
        const result = runWithFullTty(command, tui);
        done(result);
        return { render: () => [], invalidate: () => {} };
      });

      return {
        result: {
          output: ptyResult?.output ?? "(no output)",
          exitCode: ptyResult?.exitCode ?? 1,
          cancelled: false,
          truncated: false,
        },
      };
    }

    // Capture mode: run via PTY, show output in tool result
    const captureResult = await runWithPtyCapture(command, {
      cwd: ctx.cwd,
      timeoutMs: 15_000,
    });

    return {
      result: {
        output: captureResult.output,
        exitCode: captureResult.exitCode ?? 1,
        cancelled: false,
        truncated: false,
      },
    };
  });

  // -----------------------------------------------------------------------
  // 2. Register pty_exec tool — capture mode by default
  // -----------------------------------------------------------------------
  pi.registerTool({
    name: "pty_exec",
    label: "Interactive PTY",
    description:
      "Run a command with PTY (pseudo-terminal) access. " +
      "Output is captured and displayed in this tool call result. " +
      "Use for TUI applications like top, htop, or any command that needs a real terminal. " +
      "Set handoff=true for commands needing keyboard input (vim, nano, ssh).",
    promptSnippet:
      "Run terminal applications (top, htop, etc.) with PTY — output shown in tool result",
    promptGuidelines: [
      "Use pty_exec for commands that need a real terminal (top, htop, tput, etc.).",
      "Use pty_exec with handoff=true only for truly interactive apps (vim, nano, ssh).",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "The command to run" }),
      cwd: Type.Optional(
        Type.String({ description: "Working directory (defaults to current)" }),
      ),
      handoff: Type.Optional(
        Type.Boolean({
          description:
            "If true, suspends pi TUI and hands terminal to the command " +
            "(for vim, nano, ssh). Default false = capture output in tool result.",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (default 30)",
          minimum: 1,
          maximum: 300,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const command = params.command;
      const workDir = params.cwd || ctx.cwd;
      const timeoutMs = (params.timeout ?? 30) * 1000;

      // Handoff mode: truly interactive
      if (params.handoff) {
        if (ctx.mode !== "tui") {
          return {
            content: [{ type: "text", text: "Handoff mode requires TUI." }],
            details: { error: "non-tui" },
          };
        }

        const wrappedCommand = params.cwd
          ? `cd ${JSON.stringify(workDir)} && ${command}`
          : command;

        const ptyResult = await ctx.ui.custom<PtyResult>((tui, _theme, _kb, done) => {
          const result = runWithFullTty(wrappedCommand, tui);
          done(result);
          return { render: () => [], invalidate: () => {} };
        });

        return {
          content: [{ type: "text", text: ptyResult?.output ?? "(completed)" }],
          details: { exitCode: ptyResult?.exitCode ?? 0, mode: "handoff" },
        };
      }

      // Capture mode: run via PTY, return output in tool result
      onUpdate?.({
        content: [{ type: "text", text: `Running: ${command}` }],
      });

      const result = await runWithPtyCapture(command, {
        cwd: workDir,
        timeoutMs,
      });

      if (result.error) {
        return {
          content: [{ type: "text", text: `Error: ${result.error}\n${result.output}` }],
          details: { exitCode: result.exitCode, error: result.error, mode: "capture" },
        };
      }

      // Return captured output — this renders in the tool call result window
      const exitInfo = result.exitCode === 0 ? "" : `\n(exit code: ${result.exitCode})`;
      return {
        content: [{ type: "text", text: result.output + exitInfo }],
        details: { exitCode: result.exitCode ?? 0, mode: "capture" },
      };
    },

    renderCall(args, theme) {
      let label = theme.fg("toolTitle", theme.bold("pty_exec "));
      label += theme.fg("muted", args.command ?? "");
      if (args.handoff) label += theme.fg("warning", " [handoff]");
      return new Text(label, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg("muted", "Running..."), 0, 0);
      }

      const text = result.content?.[0]?.text ?? "";
      const exitCode = result.details?.exitCode;

      if (text.length === 0) {
        return new Text(theme.fg("dim", "(no output)"), 0, 0);
      }

      // Show output with exit status
      let display = text;
      if (exitCode !== undefined && exitCode !== 0) {
        display = theme.fg("error", `[exit ${exitCode}] `) + display;
      }

      // Truncate very long output in collapsed view
      if (!expanded && display.length > 2000) {
        display = display.substring(0, 2000) + "\n... (expand to see full output)";
      }

      return new Text(display, 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // 3. /pty command — capture mode
  // -----------------------------------------------------------------------
  pi.registerCommand("pty", {
    description: "Run a command with PTY capture (output stays visible)",
    handler: async (args, ctx) => {
      if (!args || args.trim() === "") {
        ctx.ui.notify("Usage: /pty <command>", "warning");
        return;
      }

      ctx.ui.setStatus("pty", `Running: ${args.trim()}`);

      const result = await runWithPtyCapture(args.trim(), {
        cwd: ctx.cwd,
        timeoutMs: 15_000,
      });

      ctx.ui.setStatus("pty", "");

      if (result.error) {
        ctx.ui.notify(`PTY error: ${result.error}`, "error");
        return;
      }

      // Show output via custom component so it stays on screen
      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        const lines = result.output.split("\n");
        const maxLines = Math.min(lines.length, 40);
        const displayLines = lines.slice(0, maxLines);
        if (lines.length > maxLines) {
          displayLines.push(`... (${lines.length - maxLines} more lines)`);
        }

        const exitInfo = result.exitCode === 0
          ? theme.fg("success", `✓ exit 0`)
          : theme.fg("error", `✗ exit ${result.exitCode}`);

        let dismissed = false;
        const component = {
          render(width: number): string[] {
            const header = theme.fg("accent", theme.bold(` PTY: ${args.trim()} `)) + exitInfo;
            const border = theme.fg("border", "─".repeat(Math.min(width, 60)));
            const content = displayLines.map((l) =>
              l.length > width ? l.substring(0, width) : l,
            );
            const footer = theme.fg("dim", " Press any key to dismiss");
            return [header, border, ...content, border, footer];
          },
          handleInput(_data: string) {
            if (!dismissed) {
              dismissed = true;
              done(undefined);
            }
          },
          invalidate() {},
        };
        return component;
      });
    },
  });
}
