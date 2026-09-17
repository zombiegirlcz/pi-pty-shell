/**
 * pi-pty-shell — Full interactive PTY extension for pi
 *
 * Two modes:
 *   1. STREAMING mode (default for pty_exec):
 *      Spawns via node-pty, streams output live via onUpdate() into
 *      the tool call result window. Output visible immediately.
 *      For interactive TUI apps (htop, top), renders inside a
 *      ctx.ui.custom() component with keyboard/mouse forwarding.
 *
 *   2. HANDOFF mode (for vim, nano, ssh):
 *      Suspends pi TUI, hands terminal to child, restores after exit.
 *
 * Usage:
 *   !htop               → interactive overlay (keyboard forwarded)
 *   !top -b -n 1        → streaming capture in tool result
 *   !vim file.txt       → handoff (full terminal)
 *   !i any-command      → force handoff
 *   /pty <command>      → streaming overlay
 *   pty_exec tool       → streaming or interactive overlay
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawnSync } from "node:child_process";
import { Text, matchesKey, Key, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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

/** Commands needing full handoff (real keyboard, full-screen TUI editor) */
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

/** Commands that are interactive TUI but can run in overlay (not full handoff) */
const OVERLAY_INTERACTIVE_COMMANDS = new Set([
  "htop", "top", "btop", "glances", "tig", "lazygit", "gitui", "ncdu",
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
    ) return true;
    const pipeIdx = trimmed.lastIndexOf("|");
    if (pipeIdx !== -1) {
      const afterPipe = trimmed.slice(pipeIdx + 1).trim();
      if (afterPipe === cmdLower || afterPipe.startsWith(`${cmdLower} `)) return true;
    }
  }
  return false;
}

function needsHandoff(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  for (const cmd of HANDOFF_ONLY_COMMANDS) {
    if (trimmed === cmd || trimmed.startsWith(`${cmd} `) || trimmed.startsWith(`${cmd}\t`))
      return true;
  }
  return false;
}

function isOverlayInteractive(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  for (const cmd of OVERLAY_INTERACTIVE_COMMANDS) {
    if (trimmed === cmd || trimmed.startsWith(`${cmd} `) || trimmed.startsWith(`${cmd}\t`))
      return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// PTY helpers
// ---------------------------------------------------------------------------

let ptyModule: any = null;
let xtermModule: any = null;

async function getPty(): Promise<any> {
  if (ptyModule) return ptyModule;
  try {
    ptyModule = await import("@lydell/node-pty");
  } catch {
    try {
      ptyModule = await import("node-pty");
    } catch {
      return null;
    }
  }
  return ptyModule;
}

async function getXterm(): Promise<any> {
  if (xtermModule) return xtermModule;
  try {
    xtermModule = await import("@xterm/headless");
  } catch {
    return null;
  }
  return xtermModule;
}

interface PtyHandle {
  process: any;
  terminal: any | null;
  cols: number;
  rows: number;
  getOutput(): string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

async function spawnPty(
  command: string,
  opts?: { cwd?: string; cols?: number; rows?: number },
): Promise<PtyHandle | null> {
  const pty = await getPty();
  if (!pty) return null;

  const cols = opts?.cols ?? process.stdout.columns ?? 80;
  const rows = opts?.rows ?? process.stdout.rows ?? 30;
  const cwd = opts?.cwd ?? process.cwd();
  const shell = process.env.SHELL || "/bin/sh";

  let terminal: any = null;
  const xterm = await getXterm();
  if (xterm) {
    terminal = new xterm.Terminal({
      allowProposedApi: true,
      cols,
      rows,
      scrollback: 5000,
    });
  }

  const ptyProcess = pty.spawn(shell, ["-c", command], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: { ...process.env, TERM: "xterm-256color" },
  });

  ptyProcess.onData((data: string) => {
    if (terminal) {
      try { terminal.write(data); } catch { /* ignore */ }
    }
  });

  return {
    process: ptyProcess,
    terminal,
    cols,
    rows,
    getOutput(): string {
      if (!terminal) return "";
      try {
        const buf = terminal.buffer.active;
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
        return lines.join("\n");
      } catch {
        return "";
      }
    },
    write(data: string) {
      try { ptyProcess.write(data); } catch { /* ignore */ }
    },
    resize(newCols: number, newRows: number) {
      try {
        ptyProcess.resize(newCols, newRows);
        if (terminal) terminal.resize(newCols, newRows);
      } catch { /* ignore */ }
    },
    kill() {
      try { ptyProcess.kill(); } catch { /* ignore */ }
      try { terminal?.dispose(); } catch { /* ignore */ }
    },
  };
}

// ---------------------------------------------------------------------------
// Full TTY handoff (vim, nano, ssh — needs real terminal)
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
// Interactive PTY overlay component (htop, top, etc.)
// Renders live PTY output, forwards keyboard input to the process.
// ---------------------------------------------------------------------------

class PtyOverlayComponent {
  private handle: PtyHandle;
  private tui: any;
  private done: (result: PtyResult) => void;
  private cachedLines: string[] = [];
  private cachedWidth = 0;
  private version = 0;
  private cachedVersion = -1;
  private disposed = false;
  private exitCode: number | null = null;
  private exitSignal: number | null = null;
  private hasExited = false;

  constructor(
    handle: PtyHandle,
    tui: any,
    done: (result: PtyResult) => void,
  ) {
    this.handle = handle;
    this.tui = tui;
    this.done = done;

    // Listen for exit
    handle.process.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      this.exitCode = exitCode;
      this.exitSignal = signal ?? null;
      this.hasExited = true;
      this.version++;
      this.tui.requestRender();
      // Auto-close after a short delay so user sees final state
      setTimeout(() => this.finish(), 500);
    });
  }

  private finish(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.handle.kill();
    const output = this.handle.getOutput();
    this.done({
      exitCode: this.exitCode,
      output: output || "(no output)",
      error: this.exitSignal ? `killed by signal ${this.exitSignal}` : undefined,
    });
  }

  handleInput(data: string): void {
    if (this.hasExited) {
      // Any key after exit dismisses
      this.finish();
      return;
    }

    // ESC or q to quit
    if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
      this.handle.kill();
      this.finish();
      return;
    }

    // Forward all input to PTY process
    this.handle.write(data);
  }

  handleMouse(event: any): any {
    if (this.hasExited) return undefined;
    // Forward mouse events to PTY (for htop, etc.)
    // SGR mouse mode: ESC [ < button ; col ; row M/m
    if (event.type === "press" || event.type === "click") {
      const seq = `\x1b[<${event.button ?? 0};${event.col ?? 1};${event.row ?? 1}M`;
      this.handle.write(seq);
      return { handled: true };
    }
    if (event.type === "release") {
      const seq = `\x1b[<${event.button ?? 0};${event.col ?? 1};${event.row ?? 1}m`;
      this.handle.write(seq);
      return { handled: true };
    }
    return undefined;
  }

  invalidate(): void {
    this.cachedWidth = 0;
    this.cachedVersion = -1;
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedVersion === this.version) {
      return this.cachedLines;
    }

    this.version++;
    const output = this.handle.getOutput();
    const lines = output.split("\n");
    const maxLines = Math.min(lines.length, 50);
    const displayLines = lines.slice(-maxLines); // show last N lines

    const header = this.hasExited
      ? `\x1b[32m✓ exit ${this.exitCode ?? "?"}\x1b[0m`
      : `\x1b[33m● running\x1b[0m`;
    const hint = this.hasExited
      ? " \x1b[2m(press any key)\x1b[0m"
      : " \x1b[2m(ESC/q to quit, keys forwarded)\x1b[0m";

    const result: string[] = [];
    result.push(truncateToWidth(`${header}${hint}`, width));
    result.push(truncateToWidth("\x1b[90m" + "─".repeat(Math.min(width - 1, 60)) + "\x1b[0m", width));

    for (const line of displayLines) {
      result.push(truncateToWidth(line, width));
    }

    this.cachedLines = result;
    this.cachedWidth = width;
    this.cachedVersion = this.version;
    return result;
  }

  dispose(): void {
    this.disposed = true;
    this.handle.kill();
  }
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

    // Handoff mode
    if (forceHandoff || needsHandoff(command)) {
      const ptyResult = await ctx.ui.custom<PtyResult>((tui, _theme, _kb, done) => {
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

    // Overlay interactive (htop, top, etc.)
    if (isOverlayInteractive(command)) {
      const ptyResult = await ctx.ui.custom<PtyResult>((tui, _theme, _kb, done) => {
        let component: PtyOverlayComponent | null = null;
        spawnPty(command, { cwd: ctx.cwd }).then((handle) => {
          if (!handle) {
            done({ exitCode: 1, output: "(PTY not available)" });
            return;
          }
          component = new PtyOverlayComponent(handle, tui, done);
        });
        return {
          render(width: number): string[] {
            if (!component) return ["\x1b[33mStarting PTY...\x1b[0m"];
            return component.render(width);
          },
          handleInput(data: string) {
            component?.handleInput(data);
            tui.requestRender();
          },
          handleMouse(event: any) {
            return component?.handleMouse(event);
          },
          invalidate() {
            component?.invalidate();
          },
        };
      });

      return {
        result: {
          output: ptyResult?.output ?? "(no output)",
          exitCode: ptyResult?.exitCode ?? 1,
          cancelled: false, truncated: false,
        },
      };
    }

    // Streaming capture (non-interactive PTY commands)
    const handle = await spawnPty(command, { cwd: ctx.cwd });
    if (!handle) {
      return {
        result: { output: "(PTY not available)", exitCode: 1, cancelled: false, truncated: false },
      };
    }

    const output = await new Promise<string>((resolve) => {
      let collected = "";
      handle.process.onData((data: string) => { collected += data; });
      handle.process.onExit(() => {
        setTimeout(() => resolve(handle.getOutput() || collected), 50);
      });
      setTimeout(() => {
        handle.kill();
        resolve(handle.getOutput() || collected || "(timeout)");
      }, 15_000);
    });

    return {
      result: {
        output: output || "(no output)",
        exitCode: 0,
        cancelled: false, truncated: false,
      },
    };
  });

  // -----------------------------------------------------------------------
  // 2. pty_exec tool — streaming + interactive overlay
  // -----------------------------------------------------------------------
  pi.registerTool({
    name: "pty_exec",
    label: "Interactive PTY",
    description:
      "Run a command with PTY access. For TUI apps (htop, top), shows a live " +
      "interactive overlay with keyboard forwarding. For other commands, streams " +
      "output into this tool result. Use handoff=true for editors (vim, nano).",
    promptSnippet:
      "Run terminal apps with live PTY output shown in an interactive overlay",
    promptGuidelines: [
      "Use pty_exec for commands needing a real terminal (top, htop, etc.).",
      "Use pty_exec with handoff=true only for editors and SSH (vim, nano, ssh).",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "The command to run" }),
      cwd: Type.Optional(Type.String({ description: "Working directory" })),
      handoff: Type.Optional(Type.Boolean({
        description: "True for full terminal handoff (vim, nano, ssh). Default false.",
      })),
      timeout: Type.Optional(Type.Number({
        description: "Timeout in seconds (default 30)", minimum: 1, maximum: 300,
      })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const command = params.command;
      const workDir = params.cwd || ctx.cwd;
      const timeoutMs = (params.timeout ?? 30) * 1000;

      // Handoff mode
      if (params.handoff) {
        if (ctx.mode !== "tui") {
          return {
            content: [{ type: "text", text: "Handoff requires TUI mode." }],
            details: { error: "non-tui", mode: "handoff" },
          };
        }
        const wrapped = params.cwd ? `cd ${JSON.stringify(workDir)} && ${command}` : command;
        const ptyResult = await ctx.ui.custom<PtyResult>((tui, _theme, _kb, done) => {
          const result = runWithFullTty(wrapped, tui);
          done(result);
          return { render: () => [], invalidate: () => {} };
        });
        return {
          content: [{ type: "text", text: ptyResult?.output ?? "(completed)" }],
          details: { exitCode: ptyResult?.exitCode ?? 0, mode: "handoff" },
        };
      }

      // Interactive overlay for TUI apps
      if (isOverlayInteractive(command) && ctx.mode === "tui") {
        onUpdate?.({ content: [{ type: "text", text: `Starting: ${command}` }] });

        const ptyResult = await ctx.ui.custom<PtyResult>((tui, _theme, _kb, done) => {
          let component: PtyOverlayComponent | null = null;

          spawnPty(command, { cwd: workDir }).then((handle) => {
            if (!handle) {
              done({ exitCode: 1, output: "(PTY not available)" });
              return;
            }
            component = new PtyOverlayComponent(handle, tui, done);
          });

          return {
            render(width: number): string[] {
              if (!component) return ["\x1b[33mStarting PTY...\x1b[0m"];
              return component.render(width);
            },
            handleInput(data: string) {
              component?.handleInput(data);
              tui.requestRender();
            },
            handleMouse(event: any) {
              return component?.handleMouse(event);
            },
            invalidate() {
              component?.invalidate();
            },
          };
        });

        return {
          content: [{ type: "text", text: ptyResult?.output ?? "(completed)" }],
          details: { exitCode: ptyResult?.exitCode ?? 0, mode: "overlay" },
        };
      }

      // Streaming capture mode
      onUpdate?.({ content: [{ type: "text", text: `Running: ${command}` }] });

      const handle = await spawnPty(command, { cwd: workDir });
      if (!handle) {
        return {
          content: [{ type: "text", text: "(PTY not available — install @lydell/node-pty)" }],
          details: { exitCode: 1, error: "no-pty", mode: "capture" },
        };
      }

      // Stream output via onUpdate periodically
      let lastUpdate = 0;
      const UPDATE_INTERVAL = 200; // ms

      const result = await new Promise<{ output: string; exitCode: number | null }>((resolve) => {
        let timer: any;

        handle.process.onData((_data: string) => {
          const now = Date.now();
          if (now - lastUpdate > UPDATE_INTERVAL) {
            lastUpdate = now;
            const current = handle.getOutput();
            if (current) {
              onUpdate?.({ content: [{ type: "text", text: current }] });
            }
          }
        });

        handle.process.onExit(({ exitCode }: { exitCode: number }) => {
          clearTimeout(timer);
          setTimeout(() => {
            const output = handle.getOutput();
            resolve({ output, exitCode });
          }, 50);
        });

        timer = setTimeout(() => {
          handle.kill();
          resolve({ output: handle.getOutput() || "(timeout)", exitCode: null });
        }, timeoutMs);
      });

      handle.kill();

      const exitInfo = result.exitCode === 0 ? "" : `\n(exit code: ${result.exitCode})`;
      return {
        content: [{ type: "text", text: (result.output || "(no output)") + exitInfo }],
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
        const text = result.content?.[0]?.text ?? "";
        if (text && text.length > 0 && !text.startsWith("Running:") && !text.startsWith("Starting:")) {
          // Show live streaming output
          const lines = text.split("\n");
          const maxLines = expanded ? 50 : 15;
          const display = lines.slice(-maxLines).join("\n");
          return new Text(theme.fg("toolOutput", display), 0, 0);
        }
        return new Text(theme.fg("muted", "Running..."), 0, 0);
      }

      const text = result.content?.[0]?.text ?? "";
      const exitCode = result.details?.exitCode;

      if (!text) return new Text(theme.fg("dim", "(no output)"), 0, 0);

      let display = text;
      if (exitCode !== undefined && exitCode !== 0) {
        display = theme.fg("error", `[exit ${exitCode}] `) + display;
      }

      if (!expanded && display.length > 3000) {
        const lines = display.split("\n");
        display = lines.slice(0, 30).join("\n") + `\n... (${lines.length - 30} more lines)`;
      }

      return new Text(display, 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // 3. /pty command — interactive overlay
  // -----------------------------------------------------------------------
  pi.registerCommand("pty", {
    description: "Run a command with live PTY overlay",
    handler: async (args, ctx) => {
      if (!args || args.trim() === "") {
        ctx.ui.notify("Usage: /pty <command>", "warning");
        return;
      }

      if (ctx.mode !== "tui") {
        ctx.ui.notify("PTY overlay requires TUI mode", "error");
        return;
      }

      const command = args.trim();

      await ctx.ui.custom<PtyResult>((tui, _theme, _kb, done) => {
        let component: PtyOverlayComponent | null = null;

        spawnPty(command, { cwd: ctx.cwd }).then((handle) => {
          if (!handle) {
            done({ exitCode: 1, output: "(PTY not available)" });
            return;
          }
          component = new PtyOverlayComponent(handle, tui, done);
        });

        return {
          render(width: number): string[] {
            if (!component) return ["\x1b[33mStarting PTY...\x1b[0m"];
            return component.render(width);
          },
          handleInput(data: string) {
            component?.handleInput(data);
            tui.requestRender();
          },
          handleMouse(event: any) {
            return component?.handleMouse(event);
          },
          invalidate() {
            component?.invalidate();
          },
        };
      });
    },
  });
}
