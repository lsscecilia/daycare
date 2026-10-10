// `daycare hook <Event>`: called by Claude Code for every session on this machine.
// Rules: be fast, never block Claude except to deny a write to a locked file, always exit 0.
import { appendFileSync } from "fs";
import { basename, relative, resolve } from "path";
import { config } from "./config";
import { one, run, tx } from "./db";
import type { Worker } from "./items";
import { P } from "./paths";
import { needsSummary } from "./summarize";
import { ago, alive, gitInfo, internalEnv, lockTtlMs, notify, now, pidStart, sh, spawnDetached } from "./util";

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function describe(tool: string, input: any): string {
  const f = input?.file_path ?? input?.notebook_path;
  switch (tool) {
    case "Edit": case "MultiEdit": return `editing ${basename(f ?? "")}`;
    case "Write": return `writing ${basename(f ?? "")}`;
    case "NotebookEdit": return `editing ${basename(f ?? "")}`;
    case "Read": return `reading ${basename(f ?? "")}`;
    case "Bash": return `running ${String(input?.command ?? "").split("\n")[0].slice(0, 40)}`;
    case "Grep": case "Glob": return "searching";
    case "WebFetch": case "WebSearch": return "browsing";
    case "Task": case "Agent": return "delegating";
    default: return tool.replace(/^mcp__\w+__/, "").toLowerCase();
  }
}

// What a stopped session needs from you, from Claude's last message: its last question if it
// asked one ("Want me to push them?"), otherwise its opening line, which is usually the outcome.
export function brief(message: string): string | null {
  const text = message
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n")
    .filter((l) => !/^\s*\|/.test(l)) // tables
    .map((l) => l.replace(/^\s*(#+|[-*>]|\d+\.)\s+/, ""))
    .join(" ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  const sentences = text.split(/(?<=[.!?])\s+/);
  const pick = sentences.filter((s) => s.endsWith("?")).pop() ?? sentences[0];
  return pick.length > 90 ? pick.slice(0, 89).trimEnd() + "…" : pick;
}

// The hook's parents are a shell and then Claude Code. Find the claude process so Daycare can
// tell later whether the session is still alive.
function findClaudePid(): number | null {
  let pid = process.ppid;
  for (let i = 0; i < 4 && pid > 1; i++) {
    const [ppid, ...cmd] = sh(["ps", "-o", "ppid=,comm=", "-p", String(pid)]).out.trim().split(/\s+/);
    if (/claude/i.test(cmd.join(" "))) return pid;
    pid = Number(ppid);
  }
  return null;
}

function ensureWorker(p: any): Worker {
  const tagged = process.env.DAYCARE_WORKER ? Number(process.env.DAYCARE_WORKER) : null;
  if (tagged) {
    run("UPDATE worker SET last_event_at = ? WHERE id = ?", now(), tagged);
    const w = one<Worker>("SELECT * FROM worker WHERE id = ?", tagged);
    if (w) return w;
  }
  const existing = one<Worker>("SELECT * FROM worker WHERE session_id = ?", p.session_id);
  if (existing) {
    // A resumed session (`claude --resume`/`--continue`) keeps its session id but runs in a new
    // process. Pick up the new pid, or reconcile would see the old one dead and end it again.
    let { pid, pid_started } = existing;
    if (existing.status === "ended" || !alive(pid, pid_started)) {
      pid = findClaudePid();
      pid_started = pid ? pidStart(pid) : null;
    }
    run("UPDATE worker SET last_event_at = ?, pid = ?, pid_started = ?, status = CASE WHEN status = 'ended' THEN 'idle' ELSE status END, ended_at = NULL WHERE id = ?",
      now(), pid, pid_started, existing.id);
    return { ...existing, pid, pid_started, status: existing.status === "ended" ? "idle" : existing.status };
  }
  const cwd = p.cwd ?? process.cwd();
  const g = gitInfo(cwd);
  const pid = findClaudePid();
  const t = now();
  const id = Number(run(`INSERT INTO worker (kind, provider, session_id, cwd, repo_root, repo_key, title, status, pid, pid_started, started_at, last_event_at)
    VALUES ('session', 'claude', ?, ?, ?, ?, '', 'idle', ?, ?, ?, ?)`,
    p.session_id, cwd, g.root ?? cwd, g.common ?? null, pid, pid ? pidStart(pid) : null, t, t).lastInsertRowid);
  return one<Worker>("SELECT * FROM worker WHERE id = ?", id)!;
}

function who(w: Worker): string {
  if (w.kind === "dispatch") return `a Daycare helper working on "${w.title}"`;
  return `another Claude session in ${basename(w.repo_root ?? "")}${w.title ? ` ("${w.title.slice(0, 40)}")` : ""}`;
}

// Returns a reason to deny the write, or null to allow it.
function lockCheck(me: Worker, path: string): string | null {
  return tx(() => {
    const held = one<{ worker_id: number; used_at: number }>("SELECT * FROM lock WHERE path = ?", path);
    if (held && held.worker_id !== me.id) {
      const h = one<Worker>("SELECT * FROM worker WHERE id = ?", held.worker_id);
      const live = h && h.status !== "ended" && (h.status === "running" || now() - held.used_at < lockTtlMs());
      if (live) return `${basename(path)} is being edited by ${who(h!)} (last edit ${ago(held.used_at)} ago). Work on other files, or stop and tell the user so they can sort it out.`;
    }
    run("INSERT INTO lock (path, worker_id, used_at) VALUES (?,?,?) ON CONFLICT (path) DO UPDATE SET worker_id = excluded.worker_id, used_at = excluded.used_at",
      path, me.id, now());
    return null;
  });
}

export async function hook(event: string) {
  try {
    if (process.env.DAYCARE_INTERNAL) return;
    const raw = await Bun.stdin.text();
    const p = JSON.parse(raw || "{}");
    if (p.agent_id || !p.session_id) return; // subagent events belong to their parent session
    const w = tx(() => ensureWorker(p));
    const t = now();
    if (p.transcript_path && p.transcript_path !== w.transcript) run("UPDATE worker SET transcript = ? WHERE id = ?", p.transcript_path, w.id);

    switch (event) {
      case "UserPromptSubmit": {
        // A session's label is your latest message, so "Your turn" names what you last asked.
        // Helpers Daycare started keep their task name.
        const said = String(p.prompt ?? "").split("\n")[0].trim().slice(0, 80);
        const title = w.kind === "dispatch" ? w.title || said : said || w.title;
        run("UPDATE worker SET status = 'running', turn_started_at = ?, doing = 'thinking', title = ?, repeat = 0, last_sig = NULL, said = NULL, summary = NULL WHERE id = ?", t, title, w.id);
        break;
      }
      case "PreToolUse": {
        if (!FILE_TOOLS.has(p.tool_name)) break;
        const f = p.tool_input?.file_path ?? p.tool_input?.notebook_path;
        if (!f) break;
        const deny = lockCheck(w, resolve(p.cwd ?? process.cwd(), f));
        if (deny) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: deny } }));
        break;
      }
      case "PostToolUse": {
        const doing = describe(p.tool_name, p.tool_input);
        const sig = String(Bun.hash(`${p.tool_name}\u0000${JSON.stringify(p.tool_input ?? null)}`));
        const repeat = sig === w.last_sig ? w.repeat + 1 : 1;
        run("UPDATE worker SET doing = ?, last_sig = ?, repeat = ?, status = CASE WHEN status IN ('idle','waiting') THEN 'running' ELSE status END WHERE id = ?",
          doing, sig, repeat, w.id);
        const f = p.tool_input?.file_path ?? p.tool_input?.notebook_path;
        if (FILE_TOOLS.has(p.tool_name) && f && w.repo_key && w.repo_root) {
          const abs = resolve(p.cwd ?? process.cwd(), f);
          const rel = relative(w.repo_root, abs);
          if (!rel.startsWith("..")) run("INSERT OR REPLACE INTO touch (worker_id, repo_key, rel_path, at) VALUES (?,?,?,?)", w.id, w.repo_key, rel, t);
          run("UPDATE lock SET used_at = ? WHERE path = ? AND worker_id = ?", t, abs, w.id);
        }
        // The same call with the same input, again and again, means it's going in circles.
        if (repeat >= config().loop_repeat && w.kind === "dispatch" && !w.kill_reason) {
          run("UPDATE worker SET kill_reason = 'stuck in a loop', kill_evidence = ? WHERE id = ?", `${doing} ${repeat} times in a row with identical input.`, w.id);
          if (w.child_pid) try { process.kill(w.child_pid, "SIGTERM"); } catch {}
        }
        break;
      }
      case "Stop":
      case "StopFailure": {
        if (w.kind === "dispatch") { run("UPDATE worker SET doing = 'wrapping up' WHERE id = ?", w.id); break; }
        // While waiting, `doing` holds what's needed from you.
        const said = event === "StopFailure" ? null : String(p.last_assistant_message ?? "") || null;
        const doing = event === "StopFailure" ? `error: ${p.error ?? "unknown"}` : brief(said ?? "");
        run("UPDATE worker SET status = 'waiting', doing = ?, said = ?, summary = NULL WHERE id = ?", doing, said, w.id);
        // A long reply gets a short summary for the room, written in the background.
        if (said && needsSummary(said)) spawnDetached(["__summarize", String(w.id)], internalEnv());
        spawnDetached(["__cost", String(w.id)], internalEnv());
        // Only ping for long turns: a quick back-and-forth means you're already watching.
        const long = w.turn_started_at && t - w.turn_started_at > config().notify_session_after_seconds * 1000;
        if (long || event === "StopFailure") notify(`${basename(w.repo_root ?? "")}: your turn`, doing || w.title || "Claude finished", false);
        break;
      }
      case "SessionEnd": {
        if (w.kind === "session") { run("UPDATE worker SET status = 'ended', ended_at = ? WHERE id = ?", t, w.id); spawnDetached(["__cost", String(w.id)], internalEnv()); }
        run("DELETE FROM lock WHERE worker_id = ?", w.id);
        break;
      }
    }
  } catch (e) {
    try { appendFileSync(P.hookLog, `${new Date().toISOString()} ${event}: ${(e as Error)?.stack ?? e}\n`); } catch {}
  }
}

