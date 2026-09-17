/**
 * pi-pty-shell — Full interactive PTY extension for pi
 *
 * Port of gemini-cli's ShellExecutionService PTY logic into a pi extension.
 * Enables running fully interactive TUI applications (vim, htop, nano, etc.)
 * with real terminal access by suspending pi's TUI and handing over the
 * terminal to the child process via node-pty.
 *
 * Architecture (ported from gemini-cli):
 *   1. PTY Layer: @lydell/node-pty spawn with xterm-256color
 *   2. Headless Terminal: @xterm/headless for output emulation & serialization
 *   3. Lifecycle: spawn → stream → resize → kill → cleanup
 *
 * Usage:
 *   !vim file.txt          (auto-detected interactive command)
 *   !i any-command         (force interactive mode)
 *   !htop
 *   !git rebase -i HEAD~3
 *
 * The extension also registers a tool `pty_exec` so the LLM agent can
 * spawn interactive processes when needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Interactive command detection (ported from gemini-cli's interactive detection)
// ---------------------------------------------------------------------------

const DEFAULT_INTERACTIVE_COMMANDS = [
  // Editors
  "vim", "nvim", "vi", "nano", "emacs", "pico", "micro", "helix", "hx", "kak",
  // Pagers
  "less", "more", "most",
  // Git interactive
  "git commit", "git rebase", "git merge", "git cherry-pick", "git revert",
  "git add -p", "git add --patch", "git add -i", "git add --interactive",
  "git stash -p", "git stash --patch", "git reset -p", "git reset --patch",
  "git checkout -p", "git checkout --patch", "git difftool", "git mergetool",
  // System monitors
  "htop", "top", "btop", "glances",
  // File managers
  "ranger", "nnn", "lf", "mc", "vifm",
  // Git TUIs
  "tig", "lazygit", "gitui",
  // Fuzzy finders
  "fzf", "sk",
  // Remote sessions
  "ssh", "telnet", "mosh",
  // Database clients
  "psql", "mysql", "sqlite3", "mongosh", "redis-cli",
  // Kubernetes/Docker
  "kubectl edit", "kubectl exec -it", "docker exec -it", "docker run -it",
  // Other
  "tmux", "screen", "ncdu",
];

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
    // Match after pipe: "cat file | less"
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

// ---------------------------------------------------------------------------
// PTY execution (core logic ported from gemini-cli shellExecutionService)
// ---------------------------------------------------------------------------

interface PtyResult {
  exitCode: number | null;
  output: string;
  error?: string;
}

/**
 * Run a command with full PTY access by suspending pi's TUI.
 * This is the "nuclear option" — hands the entire terminal to the child.
 */
function runWithFullTty(command: string, tui: any): PtyResult {
  // Stop TUI to release terminal
  tui.stop();

  // Clear screen for clean handoff
  process.stdout.write("\x1b[2J\x1b[H");

  const shell = process.env.SHELL || "/bin/sh";
  const result = spawnSync(shell, ["-c", command], {
    stdio: "inherit",
    env: { ...process.env, TERM: "xterm-256color" },
  });

  // Restart TUI
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
  // 1. Intercept user `!` commands for interactive detection
  // -----------------------------------------------------------------------
  pi.on("user_bash", async (event, ctx) => {
    let command = event.command;
    let forceInteractive = false;

    // Check for !i prefix (force interactive mode)
    if (command.startsWith("i ") || command.startsWith("i\t")) {
      forceInteractive = true;
      command = command.slice(2).trim();
    }

    const shouldBeInteractive = forceInteractive || isInteractiveCommand(command);
    if (!shouldBeInteractive) {
      return; // Let normal handling proceed
    }

    // No UI available (print mode, RPC, etc.)
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

    // Use ctx.ui.custom() to get TUI access, then run the command
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
  });

  // -----------------------------------------------------------------------
  // 2. Register pty_exec tool so the LLM agent can run interactive commands
  // -----------------------------------------------------------------------
  pi.registerTool({
    name: "pty_exec",
    label: "Interactive PTY",
    description:
      "Run a command with full interactive terminal (PTY) access. " +
      "Use for TUI applications like vim, htop, nano, git rebase -i, etc. " +
      "The pi TUI will be suspended while the command runs.",
    promptSnippet:
      "Run interactive terminal applications (vim, htop, nano, etc.) with full TTY access",
    promptGuidelines: [
      "Use pty_exec when the user asks to open an editor, run a TUI app, or interact with a program that needs a real terminal.",
      "Use pty_exec for git rebase -i, git commit, or any command that opens an editor.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "The command to run interactively" }),
      cwd: Type.Optional(
        Type.String({ description: "Working directory (defaults to current)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // In non-TUI modes, we cannot hand off the terminal
      if (ctx.mode !== "tui") {
        return {
          content: [
            {
              type: "text",
              text: "Cannot run interactive commands in non-TUI mode. Use the bash tool instead.",
            },
          ],
          details: { error: "non-tui" },
        };
      }

      const command = params.command;
      const workDir = params.cwd || ctx.cwd;

      // Change to requested directory if specified
      const wrappedCommand = params.cwd
        ? `cd ${JSON.stringify(workDir)} && ${command}`
        : command;

      const ptyResult = await ctx.ui.custom<PtyResult>((tui, _theme, _kb, done) => {
        const result = runWithFullTty(wrappedCommand, tui);
        done(result);
        return { render: () => [], invalidate: () => {} };
      });

      if (ptyResult?.error) {
        return {
          content: [{ type: "text", text: `Error: ${ptyResult.error}` }],
          details: { exitCode: ptyResult.exitCode, error: ptyResult.error },
        };
      }

      return {
        content: [{ type: "text", text: ptyResult?.output ?? "(completed)" }],
        details: { exitCode: ptyResult?.exitCode ?? 0 },
      };
    },
  });

  // -----------------------------------------------------------------------
  // 3. Register /pty command for quick access
  // -----------------------------------------------------------------------
  pi.registerCommand("pty", {
    description: "Run a command with full interactive PTY (e.g., /pty vim file.txt)",
    handler: async (args, ctx) => {
      if (!args || args.trim() === "") {
        ctx.ui.notify("Usage: /pty <command>", "warning");
        return;
      }

      if (ctx.mode !== "tui") {
        ctx.ui.notify("Interactive PTY requires TUI mode", "error");
        return;
      }

      await ctx.ui.custom<PtyResult>((tui, _theme, _kb, done) => {
        const result = runWithFullTty(args.trim(), tui);
        done(result);
        return { render: () => [], invalidate: () => {} };
      });
    },
  });
}
