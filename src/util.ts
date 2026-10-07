import { spawn } from "child_process";
import { realpathSync } from "fs";
import { basename } from "path";
import { config } from "./config";
import { kvGet, kvSet, tx } from "./db";

export const now = () => Date.now();

// Environment for anything Daycare runs on its own behalf. DAYCARE_INTERNAL makes Daycare's own
// hooks ignore the process, so e.g. a `claude -p` call for triage doesn't show up as a helper.
export function internalEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), DAYCARE_INTERNAL: "1", ...extra };
  delete env.DAYCARE_WORKER;
  return env;
}

// Environment for a helper Daycare dispatches: hooks must see it, tagged with its worker id.
export function workerEnv(workerId: number) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), DAYCARE_WORKER: String(workerId) };
  delete env.DAYCARE_INTERNAL;
  return env;
}

export function sh(argv: string[], cwd?: string, timeoutMs = 10_000) {
  const r = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe", env: internalEnv(), timeout: timeoutMs });
  return { ok: r.exitCode === 0, code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

export function real(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

export function gitInfo(dir: string): { root?: string; common?: string } {
  const r = sh(["git", "-C", dir, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);
  if (!r.ok) return {};
  const [root, common] = r.out.split("\n");
  return { root: real(root), common: real(common) };
}

export function alive(pid?: number | null, started?: string | null): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (e: any) { if (e?.code !== "EPERM") return false; }
  if (started) {
    const s = sh(["ps", "-o", "lstart=", "-p", String(pid)]).out;
    if (s && s !== started) return false; // pid was reused by another process
  }
  return true;
}

export function pidStart(pid: number): string | null {
  return sh(["ps", "-o", "lstart=", "-p", String(pid)]).out || null;
}

// Re-runs this program: the compiled binary, or `bun src/cli.ts` in development.
export function selfArgv(): string[] {
  return /\/bun$/.test(process.execPath) ? [process.execPath, Bun.main] : [process.execPath];
}

export function spawnDetached(args: string[], env: Record<string, string>) {
  const [cmd, ...rest] = [...selfArgv(), ...args];
  const child = spawn(cmd, rest, { detached: true, stdio: "ignore", env });
  child.unref();
  return child.pid!;
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "task";
}

export function ago(ms: number): string {
  const m = Math.floor((now() - ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
  return `${Math.floor(m / 1440)}d`;
}

export function copy(text: string): boolean {
  const r = Bun.spawnSync(["pbcopy"], { stdin: new Blob([text]) });
  return r.exitCode === 0;
}

export function focusUntil(): number {
  const v = Number(kvGet("focus_until") || 0);
  return v > now() ? v : 0;
}

// A macOS notification. Title and body go to osascript as arguments, never into the script.
// During focus, everything except urgent notices is held and counted instead.
export function notify(title: string, body: string, urgent = false) {
  if (process.env.DAYCARE_NO_NOTIFY) return;
  if (!urgent && focusUntil()) {
    tx(() => kvSet("focus_held", String(Number(kvGet("focus_held") || 0) + 1)));
    return;
  }
  const child = spawn("osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body],
    { detached: true, stdio: "ignore" });
  child.unref();
}

export const repoName = (p?: string | null) => (p ? basename(p) : "");

export function lockTtlMs() {
  return config().lock_ttl_minutes * 60_000;
}
