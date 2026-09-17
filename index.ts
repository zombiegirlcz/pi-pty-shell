/**
 * pi-pty-shell — PTY extension for pi (gemini-cli architecture port)
 *
 * Architecture (ported from gemini-cli shellExecutionService):
 *   1. PTY spawn via @lydell/node-pty
 *   2. @xterm/headless terminal emulation for ANSI parsing
 *   3. Debounced render (68ms) on pty.onData → serialize buffer → onUpdate()
 *   4. renderResult(isPartial=true) shows live output in tool call window
 *   5. HANDOFF mode for editors (vim, nano, ssh) — suspend TUI, full terminal
 *
 * Usage:
 *   !htop                  → streaming in tool result (live output)
 *   !top -b -n 1           → streaming capture
 *   !vim file.txt          → HANDOFF (full terminal)
 *   !i any-command         → force HANDOFF
 *   pty_exec tool          → streaming by default, handoff=true for editors
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
    process.env.INTERACTIVE_COMMANDS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const excluded = new Set(
    process.env.INTERACTIVE_EXCLUDE?.split(",").map((s) => s.trim().toLowerCase()) ?? [],
  );
  return [...DEFAULT_INTERACTIVE_COMMANDS, ...additional].filter(
    (cmd) => !excluded.has(cmd.toLowerCase()),
  );
}

function isInteractiveCommand(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  for (const cmd of getInteractiveCommands()) {
    if (trimmed === cmd || trimmed.startsWith(`${cmd} `) || trimmed.startsWith(`${cmd}\t`)) return true;
    const pipeIdx = trimmed.lastIndexOf("|");
    if (pipeIdx !== -1) {
      const afterPipe = trimmed.slice(pipeIdx + 1).trim();
      if (afterPipe === cmd || afterPipe.startsWith(`${cmd} `)) return true;
    }
  }
  return false;
}

function needsHandoff(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  for (const cmd of HANDOFF_ONLY_COMMANDS) {
    if (trimmed === cmd || trimmed.startsWith(`${cmd} `) || trimmed.startsWith(`${cmd}\t`)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// PTY singleton — shared across tool calls
// ---------------------------------------------------------------------------

let ptyModule: any = null;
let xtermModule: any = null;

async function getPty(): Promise<any> {
  if (ptyModule) return ptyModule;
  try { ptyModule = await import("@lydell/node-pty"); } catch {
    try { ptyModule = await import("node-pty"); } catch { return null; }
  }
  return ptyModule;
}

async function getXterm(): Promise<any> {
  if (xtermModule) return xtermModule;
  try { xtermModule = await import("@xterm/headless"); } catch { return null; }
  return xtermModule;
}

// ---------------------------------------------------------------------------
// Terminal buffer serialization (simplified gemini-cli terminalSerializer port)
// Reads the headless terminal buffer and produces plain text output.
// ---------------------------------------------------------------------------

function getFullBufferText(terminal: any): string {
  if (!terminal) return "";
  try {
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    let lastContent = -1;
    for (let i = buffer.length - 1; i >= 0; i--) {
      const line = buffer.getLine(i);
      if (line && line.translateToString(true).trim().length > 0) {
        lastContent = i;
        break;
      }
    }
    if (lastContent < 0) return "";
    for (let i = 0; i <= lastContent; i++) {
      const line = buffer.getLine(i);
      if (!line) { lines.push(""); continue; }
      let trimRight = true;
      if (i + 1 <= lastContent) {
        const nextLine = buffer.getLine(i + 1);
        if (nextLine?.isWrapped) trimRight = false;
      }
      const content = line.translateToString(trimRight);
      if (line.isWrapped && lines.length > 0) {
        lines[lines.length - 1] += content;
      } else {
        lines.push(content);
      }
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Active PTY registry (for backgrounding / kill support)
// ---------------------------------------------------------------------------

interface ActivePty {
  ptyProcess: any;
  terminal: any | null;
  command: string;
  cols: number;
  rows: number;
  killed: boolean;
}

const activePtys = new Map<number, ActivePty>();

// ---------------------------------------------------------------------------
// Streaming PTY execution (gemini-cli pattern: onData → debounce → onUpdate)
// ---------------------------------------------------------------------------

interface StreamResult {
  output: string;
  exitCode: number | null;
  signal: number | null;
  error?: string;
}

async function executeStreamingPty(
  command: string,
  opts: {
    cwd?: string;
    cols?: number;
    rows?: number;
    timeoutMs?: number;
    onUpdate?: (text: string) => void;
  },
): Promise<StreamResult> {
  const pty = await getPty();
  const xterm = await getXterm();

  if (!pty) {
    return { output: "(node-pty not available)", exitCode: 1, signal: null, error: "no-pty" };
  }

  const cols = opts.cols ?? process.stdout.columns ?? 80;
  const rows = opts.rows ?? process.stdout.rows ?? 30;
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const shell = process.env.SHELL || "/bin/sh";

  let terminal: any = null;
  if (xterm) {
    terminal = new xterm.Terminal({
      allowProposedApi: true,
      cols,
      rows,
      scrollback: 30000,
    });
  }

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
    return { output: `PTY spawn error: ${e.message}`, exitCode: 1, signal: null, error: e.message };
  }

  const pid = Number(ptyProcess.pid);
  activePtys.set(pid, { ptyProcess, terminal, command, cols, rows, killed: false });

  return new Promise<StreamResult>((resolve) => {
    let resolved = false;
    let renderTimeout: ReturnType<typeof setTimeout> | null = null;
    let hasStartedOutput = false;

    const renderFn = () => {
      renderTimeout = null;
      if (!terminal || !opts.onUpdate) return;

      const bufferText = getFullBufferText(terminal);
      if (!hasStartedOutput) {
        if (bufferText.trim().length === 0) return;
        hasStartedOutput = true;
      }
      opts.onUpdate(bufferText);
    };

    // Debounced render — 68ms like gemini-cli
    const scheduleRender = (finalRender = false) => {
      if (finalRender) {
        if (renderTimeout) clearTimeout(renderTimeout);
        renderFn();
        return;
      }
      if (renderTimeout) return;
      renderTimeout = setTimeout(() => {
        renderFn();
        renderTimeout = null;
      }, 68);
    };

    // pty.onData → terminal.write → debounced render
    ptyProcess.onData((data: string) => {
      if (terminal) {
        try { terminal.write(data); } catch { /* ignore */ }
      }
      scheduleRender();
    });

    // Timeout
    const timer = setTimeout(() => {
      try { ptyProcess.kill(); } catch { /* ignore */ }
      const entry = activePtys.get(pid);
      if (entry) entry.killed = true;
    }, timeoutMs);

    // Exit
    ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      clearTimeout(timer);

      // Final render after processing chain settles
      setTimeout(() => {
        scheduleRender(true);
        const output = getFullBufferText(terminal);
        try { terminal?.dispose(); } catch { /* ignore */ }
        activePtys.delete(pid);

        if (!resolved) {
          resolved = true;
          resolve({
            output: output || "(no output)",
            exitCode: exitCode ?? null,
            signal: signal ?? null,
            error: renderTimeout ? undefined : undefined,
          });
        }
      }, 100);
    });
  });
}

// ---------------------------------------------------------------------------
// Full TTY handoff (vim, nano, ssh — needs real terminal)
// ---------------------------------------------------------------------------

function runWithFullTty(command: string, tui: any): { exitCode: number | null; output: string; error?: string } {
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
    if (!shouldBeInteractive) return;

    if (ctx.mode !== "tui") {
      return {
        result: {
          output: "(interactive commands require TUI mode)",
          exitCode: 1, cancelled: false, truncated: false,
        },
      };
    }

    // Handoff mode for editors/ssh
    if (forceHandoff || needsHandoff(command)) {
      const ptyResult = await ctx.ui.custom<{ exitCode: number | null; output: string }>((tui, _theme, _kb, done) => {
        const result = runWithFullTty(command, tui);
        done(result);
        return { render: () => [], invalidate: () => {} };
      });
      return {
        result: {
          output: ptyResult?.output ?? "(no output)",
          exitCode: ptyResult?.exitCode ?? 1,
          cancelled: false, truncated: false,
        },
      };
    }

    // Streaming capture — live output shown via tool result
    let lastOutput = "";
    const result = await executeStreamingPty(command, {
      cwd: ctx.cwd,
      timeoutMs: 30_000,
      onUpdate: (text) => { lastOutput = text; },
    });

    return {
      result: {
        output: result.output || lastOutput || "(no output)",
        exitCode: result.exitCode ?? 1,
        cancelled: false, truncated: false,
      },
    };
  });

  // -----------------------------------------------------------------------
  // 2. pty_exec tool — streaming output via onUpdate()
  // -----------------------------------------------------------------------
  pi.registerTool({
    name: "pty_exec",
    label: "Interactive PTY",
    description:
      "Run a command with PTY access. Output streams live into this tool result " +
      "as the command runs (debounced at 68ms). For editors (vim, nano, ssh), " +
      "use handoff=true to suspend the pi TUI and hand the terminal to the process.",
    promptSnippet:
      "Run terminal apps with live PTY output streaming into tool result",
    promptGuidelines: [
      "Use pty_exec for commands needing a real terminal (top, htop, tput, etc.).",
      "Output streams live — you see partial results as the command runs.",
      "Use handoff=true only for editors and SSH (vim, nano, ssh, tmux).",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "The command to run" }),
      cwd: Type.Optional(Type.String({ description: "Working directory" })),
      handoff: Type.Optional(Type.Boolean({
        description: "True for full terminal handoff (vim, nano, ssh). Default false = streaming.",
      })),
      timeout: Type.Optional(Type.Number({
        description: "Timeout in seconds (default 60)", minimum: 1, maximum: 600,
      })),
    }),

    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const command = params.command;
      const workDir = params.cwd || ctx.cwd;
      const timeoutMs = (params.timeout ?? 60) * 1000;

      // Handoff mode
      if (params.handoff) {
        if (ctx.mode !== "tui") {
          return {
            content: [{ type: "text", text: "Handoff requires TUI mode." }],
            details: { error: "non-tui", mode: "handoff" },
          };
        }
        const wrapped = params.cwd ? `cd ${JSON.stringify(workDir)} && ${command}` : command;
        const ptyResult = await ctx.ui.custom<{ exitCode: number | null; output: string }>((tui, _theme, _kb, done) => {
          const result = runWithFullTty(wrapped, tui);
          done(result);
          return { render: () => [], invalidate: () => {} };
        });
        return {
          content: [{ type: "text", text: ptyResult?.output ?? "(completed)" }],
          details: { exitCode: ptyResult?.exitCode ?? 0, mode: "handoff" },
        };
      }

      // Streaming mode — onUpdate() pushes live output into tool result
      onUpdate?.({ content: [{ type: "text", text: `Starting: ${command}` }] });

      let lastText = "";
      const result = await executeStreamingPty(command, {
        cwd: workDir,
        timeoutMs,
        onUpdate: (text) => {
          lastText = text;
          onUpdate?.({ content: [{ type: "text", text }] });
        },
      });

      const finalOutput = result.output || lastText || "(no output)";
      const exitInfo = result.exitCode === 0 ? "" : `\n(exit code: ${result.exitCode})`;

      return {
        content: [{ type: "text", text: finalOutput + exitInfo }],
        details: {
          exitCode: result.exitCode ?? 0,
          signal: result.signal,
          mode: "streaming",
        },
      };
    },

    renderCall(args, theme) {
      let label = theme.fg("toolTitle", theme.bold("pty_exec "));
      label += theme.fg("muted", args.command ?? "");
      if (args.handoff) label += theme.fg("warning", " [handoff]");
      return new Text(label, 0, 0);
    },

    renderResult(result, { isPartial }, theme) {
      const text = result.content?.[0]?.text ?? "";
      const exitCode = result.details?.exitCode;

      if (isPartial) {
        // Live streaming — show current output
        if (!text || text.startsWith("Starting:")) {
          return new Text(theme.fg("muted", text || "Starting..."), 0, 0);
        }
        return new Text(theme.fg("toolOutput", text), 0, 0);
      }

      if (!text) return new Text(theme.fg("dim", "(no output)"), 0, 0);

      let display = text;
      if (exitCode !== undefined && exitCode !== 0) {
        display = theme.fg("error", `[exit ${exitCode}] `) + display;
      }
      return new Text(display, 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // 3. pty_kill tool — kill running PTY processes
  // -----------------------------------------------------------------------
  pi.registerTool({
    name: "pty_kill",
    label: "Kill PTY",
    description: "Kill a running PTY process by PID.",
    promptSnippet: "Kill a running PTY process",
    parameters: Type.Object({
      pid: Type.Number({ description: "PID of the PTY process to kill" }),
    }),
    async execute(_toolCallId, params) {
      const entry = activePtys.get(params.pid);
      if (!entry) {
        return {
          content: [{ type: "text", text: `No active PTY with PID ${params.pid}` }],
          details: { error: "not-found" },
        };
      }
      try { entry.ptyProcess.kill(); } catch { /* ignore */ }
      entry.killed = true;
      return {
        content: [{ type: "text", text: `Killed PTY ${params.pid} (${entry.command})` }],
        details: { pid: params.pid },
      };
    },
  });

  // -----------------------------------------------------------------------
  // 4. pty_list tool — list active PTY processes
  // -----------------------------------------------------------------------
  pi.registerTool({
    name: "pty_list",
    label: "List PTYs",
    description: "List all active PTY processes.",
    promptSnippet: "List active PTY processes",
    parameters: Type.Object({}),
    async execute() {
      if (activePtys.size === 0) {
        return {
          content: [{ type: "text", text: "No active PTY processes." }],
          details: { count: 0 },
        };
      }
      const lines: string[] = [];
      for (const [pid, entry] of activePtys) {
        lines.push(`PID ${pid}: ${entry.command} (${entry.cols}x${entry.rows})${entry.killed ? " [killed]" : ""}`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: activePtys.size },
      };
    },
  });

  // -----------------------------------------------------------------------
  // 5. pty_write tool — send input to running PTY
  // -----------------------------------------------------------------------
  pi.registerTool({
    name: "pty_write",
    label: "Write to PTY",
    description: "Send input (keystrokes) to a running PTY process.",
    promptSnippet: "Send keystrokes to a running PTY process",
    parameters: Type.Object({
      pid: Type.Number({ description: "PID of the PTY process" }),
      input: Type.String({ description: "Input to send (supports escape sequences like \\x03 for Ctrl+C)" }),
    }),
    async execute(_toolCallId, params) {
      const entry = activePtys.get(params.pid);
      if (!entry || entry.killed) {
        return {
          content: [{ type: "text", text: `No active PTY with PID ${params.pid}` }],
          details: { error: "not-found" },
        };
      }
      try {
        // Parse escape sequences
        const parsed = params.input.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
          String.fromCharCode(parseInt(hex, 16)),
        );
        entry.ptyProcess.write(parsed);
        return {
          content: [{ type: "text", text: `Sent ${params.input.length} chars to PTY ${params.pid}` }],
          details: { pid: params.pid },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Write error: ${e.message}` }],
          details: { error: e.message },
        };
      }
    },
  });

  // -----------------------------------------------------------------------
  // 6. pty_read tool — read current output from running PTY
  // -----------------------------------------------------------------------
  pi.registerTool({
    name: "pty_read",
    label: "Read PTY",
    description: "Read current terminal output from a running PTY process.",
    promptSnippet: "Read current output from a running PTY",
    parameters: Type.Object({
      pid: Type.Number({ description: "PID of the PTY process" }),
    }),
    async execute(_toolCallId, params) {
      const entry = activePtys.get(params.pid);
      if (!entry) {
        return {
          content: [{ type: "text", text: `No active PTY with PID ${params.pid}` }],
          details: { error: "not-found" },
        };
      }
      const output = getFullBufferText(entry.terminal);
      return {
        content: [{ type: "text", text: output || "(empty buffer)" }],
        details: { pid: params.pid, alive: !entry.killed },
      };
    },
  });

  // -----------------------------------------------------------------------
  // 7. /pty command
  // -----------------------------------------------------------------------
  pi.registerCommand("pty", {
    description: "Run a command with streaming PTY output",
    handler: async (args, ctx) => {
      if (!args || args.trim() === "") {
        ctx.ui.notify("Usage: /pty <command>", "warning");
        return;
      }
      const command = args.trim();
      ctx.ui.setStatus("pty", `Running: ${command}`);

      const result = await executeStreamingPty(command, {
        cwd: ctx.cwd,
        timeoutMs: 30_000,
      });

      ctx.ui.setStatus("pty", "");

      const exitInfo = result.exitCode === 0
        ? "✓ exit 0"
        : `✗ exit ${result.exitCode}`;
      ctx.ui.notify(`${command}: ${exitInfo}`, result.exitCode === 0 ? "info" : "warning");
    },
  });
}
