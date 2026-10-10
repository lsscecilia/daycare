// The room's command box. Plain text hands a job to a helper; text starting with "daycare"
// runs that command, from a short list. Setup, uninstall and anything else that changes
// your machine stay terminal-only.
import { existsSync, statSync } from "fs";
import { homedir } from "os";
import { internalEnv, selfArgv } from "./util";

const ALLOWED = new Set(["run", "new", "ok", "approve", "review", "retry", "resolve", "dispatch", "discard", "kill", "tell", "focus", "pause", "resume", "templates"]);

// Splits like a shell would for quoting only: no variables, globs or pipes.
export function words(s: string): string[] {
  const out: string[] = [];
  let cur = "", quote: string | null = null, started = false;
  for (const ch of s) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) { if (started) { out.push(cur); cur = ""; started = false; } continue; }
    cur += ch; started = true;
  }
  if (quote) throw new Error("There's an unclosed quote.");
  if (started) out.push(cur);
  return out;
}

export function toArgv(text: string): string[] {
  const t = text.trim();
  if (!t) throw new Error("Type a job for a helper, or a daycare command.");
  if (!/^daycare(\s|$)/.test(t)) return ["run", t];
  const w = words(t).slice(1);
  if (!w.length) throw new Error("Which command? For example: daycare approve <task>");
  if (!ALLOWED.has(w[0])) throw new Error(`Run "daycare ${w[0]}" in a terminal.`);
  return w;
}

export async function runCommand(text: string, repo?: string): Promise<{ ok: boolean; message: string }> {
  const argv = toArgv(text);
  if (repo) repo = repo.replace(/^~(?=\/|$)/, homedir());
  if (repo && !(existsSync(repo) && statSync(repo).isDirectory())) throw new Error(`There's no folder at ${repo}.`);
  const p = Bun.spawn([...selfArgv(), ...argv], { cwd: repo || undefined, env: { ...internalEnv(), NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 60_000 });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  const clean = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").trim();
  return { ok: code === 0, message: clean(code === 0 ? out : err || out) || (code === 0 ? "Done." : "That didn't work.") };
}
