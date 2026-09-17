/**
 * pi-pty-shell — interactive PTY extension for pi
 *
 * Architecture (ported from gemini-cli's ShellExecutionService):
 *
 *   ┌────────────┐   onData    ┌────────────────┐   render()   ┌────────┐
 *   │ node-pty   │ ──────────► │ xterm headless │ ───────────► │ pi TUI │
 *   │  process   │             │    buffer      │              │ overlay│
 *   └─────┬──────┘             └────────────────┘              └────┬───┘
 *         │                                                        │
 *         │ write(data)                                            │ handleInput
 *         └────────────────────────────────────────────────────────┘
 *
 * Three interaction modes:
 *   1. OVERLAY (default for TUI apps — htop/top/lazygit/…):
 *      ctx.ui.custom() component renders the live headless-terminal buffer.
 *      handleInput()  forwards keys to the PTY (Ctrl+] closes the overlay).
 *      handleMouse()  forwards SGR mouse events (fullscreen TUI only).
 *      No screen flash — the buffer is drawn in place, stays visible.
 *
 *   2. STREAM (non-interactive PTY commands — `top -b -n 1`, `script`, …):
 *      Spawn → collect → return. onUpdate() streams periodic snapshots
 *      into the tool result while the command runs.
 *
 *   3. HANDOFF (vim, nano, ssh, tmux — need the real terminal):
 *      tui.stop() → spawnSync(stdio:inherit) → tui.start().
 *
 * LLM-agent control (no UI required):
 *   pty_spawn / pty_read / pty_write / pty_kill / pty_list
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Command classification
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
  // Kubernetes / Docker
  "kubectl edit", "kubectl exec -it", "docker exec -it", "docker run -it",
  // Other
  "tmux", "screen", "ncdu",
];

/** Commands that require full terminal handoff (real keyboard, alt-screen editors). */
const HANDOFF_ONLY = new Set([
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

/** Interactive TUIs that work fine inside an overlay component (no alt-screen handoff). */
const OVERLAY_INTERACTIVE = new Set([
  "htop", "top", "btop", "glances", "tig", "lazygit", "gitui", "ncdu",
  "watch",
]);

function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function commandWords(command: string): string {
  return command.trim().toLowerCase();
}

function matchesPrefix(trimmed: string, cmd: string): boolean {
  const c = cmd.toLowerCase();
  return (
    trimmed === c ||
    trimmed.startsWith(`${c} `) ||
    trimmed.startsWith(`${c}\t`)
  );
}

function isInteractiveCommand(command: string): boolean {
  const trimmed = commandWords(command);
  const additional = envList("INTERACTIVE_COMMANDS");
  const excluded = new Set(envList("INTERACTIVE_EXCLUDE").map((s) => s.toLowerCase()));
  const commands = [...DEFAULT_INTERACTIVE_COMMANDS, ...additional].filter(
    (c) => !excluded.has(c.toLowerCase()),
  );
  for (const cmd of commands) {
    if (matchesPrefix(trimmed, cmd)) return true;
    const pipeIdx = trimmed.lastIndexOf("|");
    if (pipeIdx !== -1) {
      const afterPipe = trimmed.slice(pipeIdx + 1).trim();
      if (matchesPrefix(afterPipe, cmd)) return true;
    }
  }
  return false;
}

function needsHandoff(command: string): boolean {
  const trimmed = commandWords(command);
  for (const cmd of HANDOFF_ONLY) if (matchesPrefix(trimmed, cmd)) return true;
  return false;
}

function isOverlayInteractive(command: string): boolean {
  const trimmed = commandWords(command);
  for (const cmd of OVERLAY_INTERACTIVE) if (matchesPrefix(trimmed, cmd)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Minimal ANSI helpers (no external deps → cannot break extension load)
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Rough visible width: number of code points after stripping ANSI. */
export function visibleWidth(s: string): number {
  return [...stripAnsi(s)].length;
}

/** ANSI-aware truncate. Strips styles when truncating (safe fallback). */
export function truncateToWidth(s: string, width: number): string {
  if (width <= 0) return "";
  const plain = stripAnsi(s);
  if (plain.length <= width) return s;
  return plain.slice(0, width);
}

/** Build the SGR prefix for a cell's current style. Always resets first. */
function cellSgr(cell: any): string {
  const parts: string[] = [];
  try {
    if (cell.isFgPalette()) parts.push(`38;5;${cell.getFgColor()}`);
    else if (cell.isFgRGB()) {
      const c = cell.getFgColor();
      parts.push(`38;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`);
    }
    if (cell.isBgPalette()) parts.push(`48;5;${cell.getBgColor()}`);
    else if (cell.isBgRGB()) {
      const c = cell.getBgColor();
      parts.push(`48;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`);
    }
    if (cell.isBold()) parts.push("1");
    if (cell.isDim()) parts.push("2");
    if (cell.isItalic()) parts.push("3");
    if (cell.isUnderline()) parts.push("4");
    if (cell.isInverse()) parts.push("7");
  } catch {
    /* ignore */
  }
  return parts.length ? `\x1b[0;${parts.join(";")}m` : "\x1b[0m";
}

/**
 * Serialize a slice of the headless terminal buffer to ANSI-colored lines.
 * Mirrors gemini-cli's serializeTerminalToObject, but emits raw ANSI instead
 * of structured tokens because pi's Component.render returns strings.
 */
function serializeToAnsi(terminal: any, startY: number, endY: number): string[] {
  const buf = terminal.buffer.active;
  const cols: number = terminal.cols ?? 80;
  const nullCell = typeof buf.getNullCell === "function" ? buf.getNullCell() : null;
  const out: string[] = [];

  for (let y = startY; y < endY; y++) {
    const line = buf.getLine(y);
    if (!line) {
      out.push("");
      continue;
    }
    let lineStr = "";
    let curSgr = "\x1b[0m";
    let lastNonEmpty = -1;

    for (let x = 0; x < cols; x++) {
      let cell: any = null;
      try {
        cell = nullCell ? line.getCell(x, nullCell) : line.getCell(x);
      } catch {
        cell = null;
      }
      if (!cell) {
        lineStr += " ";
        continue;
      }
      const ch = cell.getChars() || " ";
      const sgr = cellSgr(cell);
      if (sgr !== curSgr) {
        lineStr += sgr;
        curSgr = sgr;
      }
      lineStr += ch;
      if (ch.trim().length > 0) lastNonEmpty = x;
    }

    // Trim trailing blank cells (keep styles only up to last content)
    if (lastNonEmpty < 0) {
      out.push("");
    } else {
      // Crude trim: re-serialize up to lastNonEmpty + 1
      let trimmed = "";
      let cs = "\x1b[0m";
      for (let x = 0; x <= lastNonEmpty; x++) {
        let cell: any = null;
        try {
          cell = nullCell ? line.getCell(x, nullCell) : line.getCell(x);
        } catch {
          cell = null;
        }
        if (!cell) {
          trimmed += " ";
          continue;
        }
        const ch = cell.getChars() || " ";
        const sgr = cellSgr(cell);
        if (sgr !== cs) {
          trimmed += sgr;
          cs = sgr;
        }
        trimmed += ch;
      }
      if (cs !== "\x1b[0m") trimmed += "\x1b[0m";
      out.push(trimmed);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PTY + headless terminal module loading (lazy, CJS-interop safe)
// ---------------------------------------------------------------------------

let ptyModule: any = null | undefined;
let xtermModule: any = null | undefined;

async function getPty(): Promise<any | null> {
  if (ptyModule !== undefined) return ptyModule;
  const tryLoad = async (name: string): Promise<any | null> => {
    try {
      const mod: any = await import(/* @vite-ignore */ name);
      return mod?.default ?? mod;
    } catch {
      return null;
    }
  };
  ptyModule = (await tryLoad("@lydell/node-pty")) ?? (await tryLoad("node-pty"));
  return ptyModule;
}

async function getXterm(): Promise<any | null> {
  if (xtermModule !== undefined) return xtermModule;
  try {
    const mod: any = await import(/* @vite-ignore */ "@xterm/headless");
    // CJS: { default: { Terminal }, Terminal }
    const Terminal = mod?.Terminal ?? mod?.default?.Terminal;
    xtermModule = Terminal ? { Terminal } : null;
  } catch {
    xtermModule = null;
  }
  return xtermModule;
}

// ---------------------------------------------------------------------------
// Session manager
// ---------------------------------------------------------------------------

export interface PtySession {
  id: string;
  command: string;
  cwd: string;
  ptyProcess: any;
  terminal: any;
  cols: number;
  rows: number;
  status: "running" | "exited";
  exitCode: number | null;
  exitSignal: number | null;
  rawOutput: string;
  startedAt: number;
  exitedAt: number | null;
  listeners: Set<(ev: { type: "data" } | { type: "exit" }) => void>;
}

const sessions = new Map<string, PtySession>();
let sessionCounter = 0;

function newSessionId(): string {
  sessionCounter += 1;
  return `pty-${Date.now().toString(36)}-${sessionCounter}`;
}

async function spawnSession(
  command: string,
  opts?: { cwd?: string; cols?: number; rows?: number; env?: Record<string, string | undefined> },
): Promise<PtySession | null> {
  const pty = await getPty();
  if (!pty) return null;

  const cols = Math.max(20, Math.floor(opts?.cols ?? process.stdout.columns ?? 80));
  const rows = Math.max(5, Math.floor(opts?.rows ?? process.stdout.rows ?? 30));
  const cwd = opts?.cwd ?? process.cwd();
  const shell = process.env.SHELL || "/bin/sh";

  const xterm = await getXterm();
  const terminal = xterm
    ? new xterm.Terminal({ allowProposedApi: true, cols, rows, scrollback: 5000 })
    : null;

  let ptyProcess: any;
  try {
    ptyProcess = pty.spawn(shell, ["-c", command], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: "xterm-256color", ...(opts?.env ?? {}) },
    });
  } catch {
    return null;
  }

  const session: PtySession = {
    id: newSessionId(),
    command,
    cwd,
    ptyProcess,
    terminal,
    cols,
    rows,
    status: "running",
    exitCode: null,
    exitSignal: null,
    rawOutput: "",
    startedAt: Date.now(),
    exitedAt: null,
    listeners: new Set(),
  };

  ptyProcess.onData((data: string) => {
    session.rawOutput += data;
    if (session.rawOutput.length > 2_000_000) {
      session.rawOutput = session.rawOutput.slice(-1_000_000);
    }
    if (session.terminal) {
      try {
        session.terminal.write(data);
      } catch {
        /* ignore */
      }
    }
    for (const l of session.listeners) {
      try {
        l({ type: "data" });
      } catch {
        /* ignore */
      }
    }
  });

  ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
    session.status = "exited";
    session.exitCode = exitCode;
    session.exitSignal = signal ?? null;
    session.exitedAt = Date.now();
    for (const l of session.listeners) {
      try {
        l({ type: "exit" });
      } catch {
        /* ignore */
      }
    }
    // Keep the session around for a while so pty_read() can still fetch output.
    setTimeout(() => {
      if (session.status === "exited" && !session.listeners.size) {
        disposeSession(session);
        sessions.delete(session.id);
      }
    }, 60_000).unref?.();
  });

  sessions.set(session.id, session);
  return session;
}

function disposeSession(session: PtySession): void {
  try {
    if (session.terminal?.dispose) session.terminal.dispose();
  } catch {
    /* ignore */
  }
  session.terminal = null;
}

function killSession(session: PtySession): void {
  try {
    session.ptyProcess?.kill();
  } catch {
    /* ignore */
  }
}

function writeSession(session: PtySession, data: string): void {
  if (session.status !== "running") return;
  try {
    session.ptyProcess.write(data);
  } catch {
    /* ignore */
  }
}

function resizeSession(session: PtySession, cols: number, rows: number): void {
  const c = Math.max(1, Math.floor(cols));
  const r = Math.max(1, Math.floor(rows));
  if (c === session.cols && r === session.rows) return;
  session.cols = c;
  session.rows = r;
  try {
    session.ptyProcess?.resize?.(c, r);
  } catch {
    /* ignore */
  }
  try {
    session.terminal?.resize?.(c, r);
  } catch {
    /* ignore */
  }
}

/** Plain text snapshot (no ANSI) of the full visible buffer, trailing blanks trimmed. */
function sessionText(session: PtySession): string {
  if (!session.terminal) {
    return stripAnsi(session.rawOutput).trimEnd();
  }
  try {
    const lines = serializeToAnsi(
      session.terminal,
      0,
      session.terminal.buffer.active.length,
    ).map(stripAnsi);
    // Drop trailing empties
    let last = lines.length - 1;
    while (last >= 0 && lines[last].trim().length === 0) last--;
    return lines.slice(0, last + 1).join("\n");
  } catch {
    return stripAnsi(session.rawOutput).trimEnd();
  }
}

/** ANSI-colored snapshot of the last N visible rows. */
function sessionAnsiLines(session: PtySession, maxLines: number): string[] {
  if (!session.terminal) {
    return stripAnsi(session.rawOutput).split("\n").slice(-maxLines);
  }
  try {
    const buf = session.terminal.buffer.active;
    const total = buf.length;

    // Find last non-empty line
    let last = total - 1;
    while (last >= 0) {
      const line = buf.getLine(last);
      if (line && line.translateToString(true).trim().length > 0) break;
      last--;
    }
    if (last < 0) return [];

    const start = Math.max(0, last + 1 - maxLines);
    return serializeToAnsi(session.terminal, start, last + 1);
  } catch {
    return stripAnsi(session.rawOutput).split("\n").slice(-maxLines);
  }
}

// ---------------------------------------------------------------------------
// Full terminal handoff (editors, ssh) — classic `tui.stop()` trick
// ---------------------------------------------------------------------------

interface HandoffResult {
  exitCode: number | null;
  error?: string;
}

function runHandoff(command: string, tui: any, cwd?: string): HandoffResult {
  const shell = process.env.SHELL || "/bin/sh";
  const wrapped = cwd
    ? `cd ${JSON.stringify(cwd)} && ${command}`
    : command;
  try {
    tui?.stop?.();
  } catch {
    /* ignore */
  }
  process.stdout.write("\x1b[2J\x1b[H");
  const result = spawnSync(shell, ["-c", wrapped], {
    stdio: "inherit",
    env: { ...process.env, TERM: "xterm-256color" },
  });
  try {
    tui?.start?.();
    tui?.requestRender?.(true);
  } catch {
    /* ignore */
  }
  return { exitCode: result.status, error: result.error?.message };
}

// ---------------------------------------------------------------------------
// Overlay component — live PTY buffer rendered inside pi TUI
// ---------------------------------------------------------------------------

const QUIT_KEY = "\x1d"; // Ctrl+]
const RENDER_DEBOUNCE_MS = 68; // ported from gemini-cli

class PtyOverlayComponent {
  private session: PtySession;
  private tui: any;
  private done: (result: { exitCode: number | null; output: string }) => void;
  private width = 0;
  private cachedLines: string[] = [];
  private cacheKey = -1;
  private version = 0;
  private disposed = false;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private exitTimer: ReturnType<typeof setTimeout> | null = null;
  private onData = () => this.requestRender();
  private onExit = () => {
    this.requestRender(true);
    this.exitTimer = setTimeout(() => this.finish(), 900);
  };

  constructor(
    session: PtySession,
    tui: any,
    done: (result: { exitCode: number | null; output: string }) => void,
  ) {
    this.session = session;
    this.tui = tui;
    this.done = done;
    session.listeners.add(this.onData);
    session.listeners.add(this.onExit);
  }

  private requestRender(force = false): void {
    if (this.disposed) return;
    this.version++;
    if (force) {
      if (this.renderTimer) {
        clearTimeout(this.renderTimer);
        this.renderTimer = null;
      }
      this.tui?.requestRender?.(true);
      return;
    }
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.tui?.requestRender?.();
    }, RENDER_DEBOUNCE_MS);
  }

  private finish(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    if (this.exitTimer) clearTimeout(this.exitTimer);
    this.session.listeners.delete(this.onData);
    this.session.listeners.delete(this.onExit);
    // Ensure the process is dead before closing.
    if (this.session.status === "running") killSession(this.session);
    const output = sessionText(this.session);
    this.done({
      exitCode: this.session.exitCode,
      output: output || "(no output)",
    });
  }

  // -------------------------------------------------------------------
  // Component interface
  // -------------------------------------------------------------------

  render(width: number): string[] {
    const w = Math.max(20, width);
    this.width = w;

    // Keep the PTY sized to the render width so lines fit exactly.
    if (this.session.cols !== w) {
      resizeSession(this.session, w, this.session.rows);
    }

    if (this.cacheKey === this.version && this.cachedLines.length > 0) {
      return this.cachedLines;
    }

    const termRows = Math.max(6, (process.stdout.rows ?? 30) - 2);
    const body = sessionAnsiLines(this.session, termRows);

    const running = this.session.status === "running";
    const status = running
      ? `\x1b[33m● running\x1b[0m`
      : `\x1b[32m✓ exited ${this.session.exitCode ?? "?"}\x1b[0m`;
    const hint = running
      ? `\x1b[2m keys → process · Ctrl+] quit overlay\x1b[0m`
      : `\x1b[2m press any key to close\x1b[0m`;

    const title = `\x1b[1m pty\x1b[0m \x1b[2m${truncateToWidth(this.session.command, Math.max(1, w - 30))}\x1b[0m`;
    const header = truncateToWidth(`${title}  ${status}${hint}`, w);
    const rule = `\x1b[90m${"─".repeat(Math.max(1, Math.min(w, 200)))}\x1b[0m`;

    const lines: string[] = [header, rule];
    for (const line of body) {
      lines.push(truncateToWidth(line.length > 0 ? line : " ", w));
    }
    if (body.length === 0 && running) {
      lines.push("\x1b[2m(waiting for output…)\x1b[0m");
    }

    this.cachedLines = lines;
    this.cacheKey = this.version;
    return lines;
  }

  handleInput(data: string): void {
    // Close overlay
    if (data === QUIT_KEY) {
      this.finish();
      return;
    }

    // Session already exited → any key closes
    if (this.session.status !== "running") {
      this.finish();
      return;
    }

    // Scrollback (Shift+Up / Shift+Down / Shift+PgUp / Shift+PgDn)
    if (data === "\x1b[1;2A") {
      try {
        this.session.terminal?.scrollLines?.(-1);
      } catch {
        /* ignore */
      }
      this.requestRender(true);
      return;
    }
    if (data === "\x1b[1;2B") {
      try {
        this.session.terminal?.scrollLines?.(1);
      } catch {
        /* ignore */
      }
      this.requestRender(true);
      return;
    }

    // Everything else goes to the process verbatim.
    writeSession(this.session, data);
    this.requestRender();
  }

  handleMouse(event: any): { handled?: boolean; focus?: boolean; render?: boolean } | undefined {
    if (this.session.status !== "running") return undefined;

    const type = event?.type as string;
    if (type !== "press" && type !== "release" && type !== "click" && type !== "drag" && type !== "wheel") {
      return undefined;
    }

    // Local coords are 0-based; SGR wants 1-based terminal coords.
    const col = Math.max(1, Math.floor((event?.x ?? 0) + 1));
    const row = Math.max(1, Math.floor((event?.y ?? 0) + 1));

    let buttonCode: number | null = null;
    switch (event?.button) {
      case "left":
        buttonCode = 0;
        break;
      case "middle":
        buttonCode = 1;
        break;
      case "right":
        buttonCode = 2;
        break;
      case "none":
        buttonCode = 0;
        break;
      default:
        buttonCode = null;
    }

    if (type === "wheel") {
      const delta = event?.wheelDelta ?? 0;
      const code = delta < 0 ? 64 : 65; // up / down
      writeSession(this.session, `\x1b[<${code};${col};${row}M`);
      this.requestRender();
      return { handled: true };
    }

    if (buttonCode === null) return undefined;

    if (type === "drag") {
      writeSession(this.session, `\x1b[<${buttonCode + 32};${col};${row}M`);
      this.requestRender();
      return { handled: true };
    }

    if (type === "release") {
      writeSession(this.session, `\x1b[<${buttonCode};${col};${row}m`);
      this.requestRender();
      return { handled: true };
    }

    // press / click
    writeSession(this.session, `\x1b[<${buttonCode};${col};${row}M`);
    this.requestRender();
    return { handled: true, focus: true };
  }

  invalidate(): void {
    this.cacheKey = -1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.session.listeners.delete(this.onData);
    this.session.listeners.delete(this.onExit);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    if (this.exitTimer) clearTimeout(this.exitTimer);
  }
}

// ---------------------------------------------------------------------------
// Run helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Spawn and wait until the process exits (or the timeout fires). */
async function runToCompletion(
  command: string,
  opts: { cwd?: string; timeoutMs?: number; onSnapshot?: (text: string) => void },
): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
  const session = await spawnSession(command, { cwd: opts?.cwd });
  if (!session) {
    return { output: "(PTY unavailable — install @lydell/node-pty)", exitCode: 1, timedOut: false };
  }

  let timedOut = false;
  const interval = setInterval(() => {
    opts?.onSnapshot?.(sessionText(session));
  }, 250);

  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;

  while (session.status === "running") {
    if (Date.now() > deadline) {
      timedOut = true;
      killSession(session);
      break;
    }
    await sleep(60);
  }

  clearInterval(interval);
  // Give the headless terminal a tick to flush pending writes.
  await sleep(80);

  const output = sessionText(session);
  const exitCode = session.exitCode;
  disposeSession(session);
  sessions.delete(session.id);
  return { output, exitCode, timedOut };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // =======================================================================
  // 1. user_bash — `!htop`, `!vim`, `!i <cmd>`
  // =======================================================================
  pi.on("user_bash", async (event, ctx) => {
    let command = event.command;
    let forceHandoff = false;

    if (command.startsWith("i ") || command.startsWith("i\t")) {
      forceHandoff = true;
      command = command.slice(2).trim();
    }

    if (!forceHandoff && !isInteractiveCommand(command)) return;

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

    const useHandoff = forceHandoff || needsHandoff(command);
    const useOverlay = !useHandoff && (isOverlayInteractive(command) || !needsHandoff(command));

    if (useHandoff) {
      const r = await ctx.ui.custom<HandoffResult>((tui, _t, _k, done) => {
        const out = runHandoff(command, tui, ctx.cwd);
        done(out);
        return { render: () => [], invalidate: () => {} };
      });
      return {
        result: {
          output:
            r?.exitCode === 0
              ? "(interactive command completed successfully)"
              : `(interactive command exited with code ${r?.exitCode ?? "?"})`,
          exitCode: r?.exitCode ?? 1,
          cancelled: false,
          truncated: false,
        },
      };
    }

    if (useOverlay) {
      const session = await spawnSession(command, { cwd: ctx.cwd });
      if (!session) {
        return {
          result: { output: "(PTY unavailable)", exitCode: 1, cancelled: false, truncated: false },
        };
      }
      const result = await ctx.ui.custom<{ exitCode: number | null; output: string }>(
        (tui, _t, _k, done) => new PtyOverlayComponent(session, tui, done) as any,
      );
      return {
        result: {
          output: result?.output ?? "(no output)",
          exitCode: result?.exitCode ?? 1,
          cancelled: false,
          truncated: false,
        },
      };
    }

    // Fallback — stream once and return.
    const { output, exitCode } = await runToCompletion(command, { cwd: ctx.cwd, timeoutMs: 15_000 });
    return {
      result: {
        output: output || "(no output)",
        exitCode: exitCode ?? 1,
        cancelled: false,
        truncated: false,
      },
    };
  });

  // =======================================================================
  // 2. pty_exec — blocking tool for the LLM
  // =======================================================================
  pi.registerTool({
    name: "pty_exec",
    label: "Interactive PTY",
    description:
      "Run a command with PTY access. TUI apps (htop, top, lazygit…) open a " +
      "live overlay with keyboard forwarding. Other commands stream their output " +
      "into this tool result. Use handoff=true for alt-screen editors (vim, nano, ssh).",
    promptSnippet:
      "Run terminal apps with a live PTY overlay (htop/top) or streamed output",
    promptGuidelines: [
      "Use pty_exec for commands that need a real terminal (top, htop, tput, script).",
      "Use pty_exec with handoff=true only for alt-screen apps (vim, nano, ssh, tmux).",
      "For long-running background shells the agent should drive, use pty_spawn instead.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Command to run" }),
      cwd: Type.Optional(Type.String({ description: "Working directory (default: session cwd)" })),
      handoff: Type.Optional(
        Type.Boolean({ description: "Full terminal handoff for alt-screen apps. Default false." }),
      ),
      timeout: Type.Optional(
        Type.Number({ description: "Timeout in seconds (default 30)", minimum: 1, maximum: 600 }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const command = params.command;
      const workDir = params.cwd || ctx.cwd;
      const timeoutMs = (params.timeout ?? 30) * 1000;

      // Alt-screen handoff
      if (params.handoff) {
        if (ctx.mode !== "tui") {
          return {
            content: [{ type: "text", text: "handoff requires TUI mode" }],
            details: { mode: "handoff", error: "non-tui" },
          };
        }
        const r = await ctx.ui.custom<HandoffResult>((tui, _t, _k, done) => {
          const out = runHandoff(command, tui, workDir);
          done(out);
          return { render: () => [], invalidate: () => {} };
        });
        const ok = r?.exitCode === 0;
        return {
          content: [
            {
              type: "text",
              text: ok
                ? "(interactive command completed successfully)"
                : `(interactive command exited with code ${r?.exitCode ?? "?"}${r?.error ? `: ${r.error}` : ""})`,
            },
          ],
          details: { mode: "handoff", exitCode: r?.exitCode ?? null },
        };
      }

      // Overlay for interactive TUIs (TUI mode only)
      if (ctx.mode === "tui" && isOverlayInteractive(command)) {
        onUpdate?.({ content: [{ type: "text", text: `Starting: ${command}` }] });
        const session = await spawnSession(command, { cwd: workDir });
        if (!session) {
          return {
            content: [{ type: "text", text: "(PTY unavailable — install @lydell/node-pty)" }],
            details: { mode: "overlay", error: "no-pty" },
          };
        }
        const result = await ctx.ui.custom<{ exitCode: number | null; output: string }>(
          (tui, _t, _k, done) => new PtyOverlayComponent(session, tui, done) as any,
        );
        const text = result?.output ?? "(no output)";
        return {
          content: [{ type: "text", text }],
          details: { mode: "overlay", exitCode: result?.exitCode ?? null },
        };
      }

      // Streaming capture
      onUpdate?.({ content: [{ type: "text", text: `Running: ${command}` }] });

      const { output, exitCode, timedOut } = await runToCompletion(command, {
        cwd: workDir,
        timeoutMs,
        onSnapshot: (snap) => {
          if (signal?.aborted) return;
          onUpdate?.({ content: [{ type: "text", text: snap || `Running: ${command}` }] });
        },
      });

      const trimmed = output.trim() || "(no output)";
      const tail = timedOut ? `\n(timed out after ${timeoutMs / 1000}s)` : exitCode === 0 ? "" : `\n(exit code: ${exitCode})`;
      return {
        content: [{ type: "text", text: trimmed + tail }],
        details: { mode: "capture", exitCode: exitCode ?? null, timedOut },
      };
    },

    renderCall(args, theme) {
      const title = theme.fg("toolTitle", theme.bold("pty_exec"));
      const cmd = theme.fg("muted", ` ${args.command ?? ""}`);
      const tag = args.handoff ? theme.fg("warning", " [handoff]") : "";
      return {
        render: (width: number) => [truncateToWidth(`${title}${cmd}${tag}`, width)],
        invalidate: () => {},
      } as any;
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const text: string = result.content?.[0]?.text ?? "";
      const exitCode = (result.details as any)?.exitCode;

      return {
        render: (width: number) => {
          const out: string[] = [];
          if (isPartial) {
            const lines = text.split("\n");
            const cap = expanded ? 60 : 20;
            for (const l of lines.slice(-cap)) out.push(truncateToWidth(l, width));
            if (out.length === 0) out.push(theme.fg("muted", "running…"));
            return out;
          }
          if (!text) return [theme.fg("dim", "(no output)")];
          const lines = text.split("\n");
          const cap = expanded ? 500 : 40;
          const shown = lines.slice(0, cap);
          for (const l of shown) out.push(truncateToWidth(l, width));
          if (lines.length > cap) {
            out.push(theme.fg("dim", `… (${lines.length - cap} more lines; expand to see)`));
          }
          if (exitCode !== undefined && exitCode !== null && exitCode !== 0) {
            out.unshift(theme.fg("error", `[exit ${exitCode}]`));
          }
          return out;
        },
        invalidate: () => {},
      } as any;
    },
  });

  // =======================================================================
  // 3. Agent-side PTY control (no UI required)
  // =======================================================================

  pi.registerTool({
    name: "pty_spawn",
    label: "PTY Spawn",
    description:
      "Start a long-running command in a background PTY session and return its id " +
      "plus an initial output snapshot. Use pty_read/pty_write/pty_kill to drive it. " +
      "Prefer this over pty_exec when you need to interact with the process.",
    promptSnippet: "Spawn a background PTY session and return its id + initial output",
    parameters: Type.Object({
      command: Type.String({ description: "Command to run" }),
      cwd: Type.Optional(Type.String()),
      cols: Type.Optional(Type.Number({ minimum: 20, maximum: 500 })),
      rows: Type.Optional(Type.Number({ minimum: 5, maximum: 200 })),
      wait_ms: Type.Optional(
        Type.Number({ description: "Milliseconds to wait before the first snapshot (default 400)", minimum: 0, maximum: 10000 }),
      ),
    }),
    async execute(_id, params) {
      const session = await spawnSession(params.command, {
        cwd: params.cwd,
        cols: params.cols,
        rows: params.rows,
      });
      if (!session) throw new Error("PTY unavailable — install @lydell/node-pty");
      await sleep(params.wait_ms ?? 400);
      return {
        content: [
          {
            type: "text",
            text: `sessionId: ${session.id}\ncommand: ${session.command}\ncwd: ${session.cwd}\nstatus: ${session.status}\n\n${sessionText(session) || "(no output yet)"}`,
          },
        ],
        details: { sessionId: session.id, status: session.status, exitCode: session.exitCode },
      };
    },
  });

  pi.registerTool({
    name: "pty_read",
    label: "PTY Read",
    description: "Return the current visible buffer of a background PTY session (plain text).",
    promptSnippet: "Read the current buffer of a PTY session",
    parameters: Type.Object({
      sessionId: Type.String(),
      max_lines: Type.Optional(Type.Number({ minimum: 1, maximum: 5000 })),
    }),
    async execute(_id, params) {
      const s = sessions.get(params.sessionId);
      if (!s) throw new Error(`Unknown session: ${params.sessionId}`);
      const text = sessionText(s);
      const lines = text.split("\n");
      const cap = params.max_lines ?? lines.length;
      const shown = lines.slice(-cap).join("\n");
      return {
        content: [
          {
            type: "text",
            text: `status: ${s.status}${s.status === "exited" ? ` (exit ${s.exitCode})` : ""}\n\n${shown || "(no output)"}`,
          },
        ],
        details: { sessionId: s.id, status: s.status, exitCode: s.exitCode, lines: lines.length },
      };
    },
  });

  pi.registerTool({
    name: "pty_write",
    label: "PTY Write",
    description:
      "Send raw input to a background PTY session. Escape sequences are supported " +
      "in the string (e.g. \"\\r\" for Enter, \"\\u001b[A\" for ArrowUp, \"\\u0003\" for Ctrl+C).",
    promptSnippet: "Write raw input to a PTY session",
    parameters: Type.Object({
      sessionId: Type.String(),
      data: Type.String({ description: "Raw bytes to write (\\r, \\n, \\t, \\u001b escapes allowed)" }),
      wait_ms: Type.Optional(Type.Number({ description: "Wait before returning a snapshot (default 300)", minimum: 0, maximum: 10000 })),
    }),
    async execute(_id, params) {
      const s = sessions.get(params.sessionId);
      if (!s) throw new Error(`Unknown session: ${params.sessionId}`);
      if (s.status !== "running") throw new Error(`Session ${s.id} already exited`);
      writeSession(s, params.data);
      await sleep(params.wait_ms ?? 300);
      return {
        content: [{ type: "text", text: sessionText(s) || "(no output yet)" }],
        details: { sessionId: s.id, status: s.status },
      };
    },
  });

  pi.registerTool({
    name: "pty_kill",
    label: "PTY Kill",
    description: "Terminate a PTY session and return its final output.",
    promptSnippet: "Kill a PTY session",
    parameters: Type.Object({ sessionId: Type.String() }),
    async execute(_id, params) {
      const s = sessions.get(params.sessionId);
      if (!s) throw new Error(`Unknown session: ${params.sessionId}`);
      if (s.status === "running") {
        killSession(s);
        await sleep(150);
      }
      const out = sessionText(s);
      disposeSession(s);
      sessions.delete(s.id);
      return {
        content: [{ type: "text", text: out || "(no output)" }],
        details: { sessionId: params.sessionId, exitCode: s.exitCode },
      };
    },
  });

  pi.registerTool({
    name: "pty_list",
    label: "PTY List",
    description: "List active PTY sessions.",
    promptSnippet: "List PTY sessions",
    parameters: Type.Object({}),
    async execute() {
      if (sessions.size === 0) {
        return { content: [{ type: "text", text: "(no active PTY sessions)" }], details: { count: 0 } };
      }
      const rows = [...sessions.values()].map(
        (s) =>
          `${s.id}  ${s.status.padEnd(7)} ${s.status === "exited" ? `exit=${s.exitCode ?? "?"}` : `pid=${s.ptyProcess?.pid ?? "?"}`}  ${s.command}`,
      );
      return {
        content: [{ type: "text", text: rows.join("\n") }],
        details: { count: sessions.size },
      };
    },
  });

  // =======================================================================
  // 4. /pty command — interactive overlay shortcut
  // =======================================================================
  pi.registerCommand("pty", {
    description: "Run a command in a live PTY overlay (e.g. /pty htop)",
    handler: async (args, ctx) => {
      const command = (args ?? "").trim();
      if (!command) {
        ctx.ui.notify("Usage: /pty <command>", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("PTY overlay requires TUI mode", "error");
        return;
      }
      const session = await spawnSession(command, { cwd: ctx.cwd });
      if (!session) {
        ctx.ui.notify("PTY unavailable — install @lydell/node-pty", "error");
        return;
      }
      await ctx.ui.custom<{ exitCode: number | null; output: string }>(
        (tui, _t, _k, done) => new PtyOverlayComponent(session, tui, done) as any,
      );
    },
  });

  // =======================================================================
  // 5. Cleanup on shutdown
  // =======================================================================
  pi.on("session_shutdown", async () => {
    for (const s of sessions.values()) {
      if (s.status === "running") killSession(s);
      disposeSession(s);
    }
    sessions.clear();
  });
}
