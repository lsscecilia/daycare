import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
// One snapshot of everything, shaped for the board (`daycare`) and the room UI.
import { basename } from "path";
import { config } from "./config";
import { all, kvGet, one } from "./db";
import { activeStep, cantTell, checks, getItem, type Item, type Step, type Worker } from "./items";
import { loadProvider } from "./provider";
import { reconcile } from "./reconcile";
import type { Summary } from "./summarize";
import type { Finding, Message } from "./triage";
import { focusUntil } from "./util";

export type Helper = {
  id: number; kind: "dispatch" | "session"; name: string; look: string; state: "working" | "waiting" | "stuck" | "idle";
  task: string; doing: string | null; since: number; spent: number | null; budget: number | null; files: string[]; resume: string | null; item: string | null;
  tell: boolean; queued: string | null; // whether the box can message it; a message waiting for this run to end
  summary: Summary | null; // a waiting session's last reply, made glanceable; the full reply is in its terminal
};
export type Card = {
  key: string; kind: "stuck" | "msg" | "review" | "test" | "step" | "done"; title: string; sub: string | null; at: number;
  item?: string; msg?: number; checks?: { t: string; d: boolean }[]; result?: string | null; changes?: string | null;
  commands?: string[]; urgency?: string; quote?: string | null; findings?: Finding[]; draft?: string | null; failed?: boolean;
  tell?: boolean;
};
export type View = {
  focus: { until: number; held: number }; helpers: Helper[]; conflicts: { a: number; b: number; file: string }[];
  cards: Card[]; reading: number; stats: { working: number; helpers: number; spent: number; doneToday: number };
  repos: string[]; // where you've worked lately, newest first: the room's command box offers these
  allRepos: string[]; // every git repo in your repo folders, for the folder picker's search
};

const LOOKS = ["claude2", "cursor", "claude"];
const label = (provider: string | null) => {
  if (!provider || provider === "claude") return "Claude";
  try { return loadProvider(provider).label?.split(/\s+/)[0] ?? provider; } catch { return provider; }
};

function resumeFor(w?: Worker | null): string | null {
  if (!w?.session_id) return null;
  if (w.provider && w.provider !== "claude") {
    try {
      const r = loadProvider(w.provider).work?.resume;
      return r ? `cd ${w.cwd} && ${r.map((a) => a.replace("{session}", w.session_id!)).join(" ")}` : null;
    } catch { return null; }
  }
  return `cd ${w.cwd} && claude --resume ${w.session_id}`;
}

export function view(doReconcile = true): View {
  if (doReconcile) reconcile();
  const loop = config().loop_repeat;
  const workers = all<Worker>("SELECT * FROM worker WHERE status != 'ended' ORDER BY started_at");
  const locks = all<{ path: string; worker_id: number }>("SELECT path, worker_id FROM lock");

  const helpers: Helper[] = workers.map((w) => {
    const stuck = w.repeat >= loop;
    const state = stuck ? "stuck" : w.kind === "dispatch" ? "working" : w.status === "running" ? "working" : w.status === "waiting" ? "waiting" : "idle";
    return {
      id: w.id, kind: w.kind, state,
      name: w.kind === "dispatch" ? label(w.provider) : basename(w.repo_root ?? w.cwd ?? "") || "Claude",
      look: w.kind === "dispatch" ? (w.provider === "claude" || !w.provider ? "claude" : "bot") : LOOKS[w.id % LOOKS.length],
      task: w.title || "new session", doing: w.doing, since: w.kind === "session" && w.turn_started_at ? w.turn_started_at : w.started_at,
      spent: w.spent, budget: w.kind === "dispatch" ? w.budget : null,
      files: locks.filter((l) => l.worker_id === w.id).map((l) => basename(l.path)),
      resume: resumeFor(w), item: w.kind === "dispatch" ? w.title : null,
      summary: state === "waiting" && w.summary ? JSON.parse(w.summary) : null,
      ...(() => { const it = w.kind === "dispatch" && w.item_id ? getItem(w.item_id) : null; return { tell: !!it && !cantTell(it), queued: it?.queued ?? null }; })(),
    };
  });

  // Two live helpers changing the same file in the same repo (even in different worktrees).
  const live = new Set(workers.map((w) => w.id));
  const touches = all<{ worker_id: number; repo_key: string; rel_path: string }>("SELECT worker_id, repo_key, rel_path FROM touch").filter((t) => live.has(t.worker_id));
  const conflicts: View["conflicts"] = [];
  const byFile = new Map<string, number[]>();
  for (const t of touches) byFile.set(`${t.repo_key}\u0000${t.rel_path}`, [...(byFile.get(`${t.repo_key}\u0000${t.rel_path}`) ?? []), t.worker_id]);
  for (const [k, ids] of byFile) if (ids.length > 1) conflicts.push({ a: ids[0], b: ids[1], file: k.split("\u0000")[1] });

  const cards: Card[] = [];
  const items = all<Item>("SELECT * FROM item WHERE status = 'active' OR (status = 'done' AND reviewed_at IS NULL) ORDER BY updated_at");
  for (const it of items) {
    const lastWorker = one<Worker>("SELECT * FROM worker WHERE item_id = ? ORDER BY id DESC LIMIT 1", it.id);
    const where = it.worktree ?? it.repo;
    if (it.status === "done") {
      const last = one<Step>("SELECT * FROM step WHERE item_id = ? ORDER BY idx DESC LIMIT 1", it.id);
      const r = last?.result ? JSON.parse(last.result) : null;
      cards.push({ key: `i${it.id}`, kind: "done", title: it.slug, sub: "Finished", at: it.updated_at, item: it.slug, result: r?.text ?? null, changes: r?.changes ?? null,
        commands: [`cd ${where}`, ...(it.base ? [`git diff ${it.base.slice(0, 10)}`] : [])] });
      continue;
    }
    const s = activeStep(it.id);
    if (!s) continue;
    if (s.status === "failed" || s.status === "needs_reconcile") {
      cards.push({ key: `i${it.id}`, kind: "stuck", title: it.slug, sub: s.failure_reason, at: it.updated_at, item: it.slug, result: s.evidence,
        commands: [`cd ${where}`, ...(resumeFor(lastWorker) ? [resumeFor(lastWorker)!] : [])] });
      continue;
    }
    if (s.owner !== "me") continue; // a helper has it; it shows in the room
    const prev = one<Step>("SELECT * FROM step WHERE item_id = ? AND idx < ? ORDER BY idx DESC LIMIT 1", it.id, s.idx);
    const cl = checks(s);
    if (cl.length) cards.push({ key: `i${it.id}`, kind: "test", title: it.slug, sub: s.name, at: s.started_at ?? it.updated_at, item: it.slug, checks: cl });
    else if (prev?.owner === "agent" && prev.result) {
      const r = JSON.parse(prev.result);
      cards.push({ key: `i${it.id}`, kind: "review", title: it.slug, sub: s.name, at: s.started_at ?? it.updated_at, item: it.slug, result: r.text, changes: r.changes,
        commands: [`cd ${where}`, ...(it.base ? [`git diff ${it.base.slice(0, 10)}`] : []), ...(resumeFor(lastWorker) ? [resumeFor(lastWorker)!] : [])] });
    } else cards.push({ key: `i${it.id}`, kind: "step", title: it.slug, sub: s.name, at: s.started_at ?? it.updated_at, item: it.slug });
  }

  for (const c of cards) if (c.item) { const it = items.find((i) => i.slug === c.item); c.tell = !!it && !cantTell(it); }

  const msgs = all<Message>("SELECT * FROM message WHERE status IN ('ready','failed') ORDER BY created_at");
  for (const m of msgs) {
    cards.push({
      key: `m${m.id}`, kind: "msg", msg: m.id, at: m.updated_at, failed: m.status === "failed",
      title: m.status === "failed" ? "Couldn't read a message" : `${m.sender ?? "Someone"}${m.channel ? ` · ${m.channel}` : ""}`,
      sub: m.status === "failed" ? m.error : m.summary, urgency: m.urgency ?? undefined, quote: m.text ?? m.ocr,
      findings: m.findings ? JSON.parse(m.findings) : [], draft: m.draft,
    });
  }
  const order = { stuck: 0, msg: 1, review: 2, test: 3, step: 3, done: 4 } as const;
  cards.sort((a, b) => (a.urgency === "P0" ? -1 : 0) - (b.urgency === "P0" ? -1 : 0) || order[a.kind] - order[b.kind] || a.at - b.at);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const doneToday = (one<{ n: number }>("SELECT COUNT(*) n FROM item WHERE status = 'done' AND updated_at >= ?", today.getTime())?.n ?? 0)
    + (one<{ n: number }>("SELECT COUNT(*) n FROM message WHERE status = 'done' AND updated_at >= ?", today.getTime())?.n ?? 0);
  const spent = one<{ s: number }>("SELECT COALESCE(SUM(spent), 0) s FROM worker WHERE started_at >= ?", today.getTime())?.s ?? 0;

  return {
    focus: { until: focusUntil(), held: Number(kvGet("focus_held") || 0) },
    helpers, conflicts, cards,
    reading: one<{ n: number }>("SELECT COUNT(*) n FROM message WHERE status = 'reading'")?.n ?? 0,
    stats: { working: helpers.filter((h) => h.state === "working").length, helpers: helpers.length, spent, doneToday },
    repos: recentRepos(),
    allRepos: foundRepos(),
  };
}


function recentRepos(): string[] {
  const rows = all<{ r: string }>(`SELECT r FROM (
      SELECT repo_root r, COALESCE(last_event_at, started_at) t FROM worker WHERE kind = 'session' AND repo_root IS NOT NULL
      UNION ALL SELECT repo r, updated_at t FROM item)
    GROUP BY r ORDER BY MAX(t) DESC LIMIT 20`);
  return rows.map((x) => x.r).filter((r) => !r.includes("/.worktrees/") && existsSync(r)).slice(0, 10);
}

// Git repos in your repo folders, two levels deep (so ~/Repository/archive/old-thing counts).
// Scanning takes a moment, and the room asks every second, so it's cached for a minute.
let found: { at: number; repos: string[] } | null = null;
function foundRepos(): string[] {
  if (found && Date.now() - found.at < 60_000) return found.repos;
  const repos: string[] = [];
  const dirs = (d: string) => { try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules").map((e) => join(d, e.name)); } catch { return []; } };
  for (const f of config().repo_folders) {
    const root = f.replace(/^~(?=\/|$)/, homedir());
    for (const a of dirs(root)) {
      if (existsSync(join(a, ".git"))) { repos.push(a); continue; }
      for (const b of dirs(a)) if (existsSync(join(b, ".git"))) repos.push(b);
    }
  }
  found = { at: Date.now(), repos: [...new Set(repos)].sort((x, y) => basename(x).localeCompare(basename(y), undefined, { sensitivity: "base" })) };
  return found.repos;
}
