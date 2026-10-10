// Work items and their steps: the state machine behind everything Daycare shows.
import { appendFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { config } from "./config";
import { all, one, run, tx } from "./db";
import { P } from "./paths";
import { loadProvider } from "./provider";
import { loadTemplate, render, type TemplateStep } from "./templates";
import { gitInfo, notify, now, pidStart, real, sh, slugify, spawnDetached, workerEnv } from "./util";

export type Item = {
  id: number; slug: string; title: string; repo: string; worktree: string | null; branch: string | null; base: string | null;
  here: number; template: string | null; status: string; reviewed_at: number | null; created_at: number; updated_at: number;
  queued: string | null;
};
export type Step = {
  id: number; item_id: number; idx: number; name: string; owner: "me" | "agent"; status: string; provider: string | null;
  prompt: string | null; checklist: string | null; budget_usd: number | null; max_minutes: number | null;
  failure_reason: string | null; evidence: string | null; result: string | null; started_at: number | null; completed_at: number | null;
  followup: string | null; followup_session: string | null;
};
export type Worker = {
  id: number; kind: "dispatch" | "session"; provider: string | null; session_id: string | null; item_id: number | null; step_id: number | null;
  pid: number | null; pid_started: string | null; child_pid: number | null; cwd: string | null; repo_root: string | null; repo_key: string | null;
  title: string | null; status: string; doing: string | null; last_sig: string | null; repeat: number; kill_reason: string | null; kill_evidence: string | null;
  spent: number | null; budget: number | null; out_path: string | null; err_path: string | null;
  started_at: number; last_event_at: number | null; turn_started_at: number | null; ended_at: number | null;
  said: string | null; summary: string | null; transcript: string | null;
};
export type Check = { t: string; d: boolean };

export const getItem = (id: number) => one<Item>("SELECT * FROM item WHERE id = ?", id);
export const getStep = (id: number) => one<Step>("SELECT * FROM step WHERE id = ?", id);
export const getWorker = (id: number) => one<Worker>("SELECT * FROM worker WHERE id = ?", id);
export const activeStep = (itemId: number) =>
  one<Step>("SELECT * FROM step WHERE item_id = ? AND status IN ('active','failed','needs_reconcile') ORDER BY idx LIMIT 1", itemId);
export const checks = (s: Step): Check[] => (s.checklist ? JSON.parse(s.checklist) : []);

// Side effects (spawning helpers, notifications) run only after the transaction commits.
export type Fx = { dispatch: number[]; notes: [string, string, boolean][] };
export function txfx<T>(fn: (fx: Fx) => T): T {
  const fx: Fx = { dispatch: [], notes: [] };
  const r = tx(() => fn(fx));
  for (const [t, b, u] of fx.notes) notify(t, b, u);
  for (const s of fx.dispatch) startStep(s);
  return r;
}

export function log(stepId: number, from: string, to: string, source: string, note?: string) {
  run("INSERT INTO transition (step_id, from_status, to_status, source, note, at) VALUES (?,?,?,?,?,?)", stepId, from, to, source, note ?? null, now());
}

export function enterStep(stepId: number, fx: Fx, source = "daycare") {
  const s = getStep(stepId)!;
  const it = getItem(s.item_id)!;
  run("UPDATE step SET status = 'active', started_at = ?, failure_reason = NULL, evidence = NULL WHERE id = ?", now(), stepId);
  run("UPDATE item SET updated_at = ? WHERE id = ?", now(), it.id);
  log(stepId, s.status, "active", source);
  if (s.owner === "agent") fx.dispatch.push(stepId);
  else fx.notes.push([`Your turn: ${it.slug}`, s.name, false]);
}

export function completeStep(stepId: number, fx: Fx, source: string, result?: string) {
  const s = getStep(stepId)!;
  const it = getItem(s.item_id)!;
  run("UPDATE step SET status = 'done', completed_at = ?, result = COALESCE(?, result) WHERE id = ?", now(), result ?? null, stepId);
  log(stepId, s.status, "done", source);
  const next = one<Step>("SELECT * FROM step WHERE item_id = ? AND idx > ? AND status = 'pending' ORDER BY idx LIMIT 1", it.id, s.idx);
  if (next) return enterStep(next.id, fx, source);
  // Last step. If you did it yourself, you've seen the result; otherwise it waits for a look.
  const reviewed = s.owner === "me" ? now() : null;
  run("UPDATE item SET status = 'done', reviewed_at = ?, updated_at = ? WHERE id = ?", reviewed, now(), it.id);
  if (!reviewed) fx.notes.push([`Done: ${it.slug}`, "Finished. Take a look when you can.", false]);
}

export function failStep(stepId: number, reason: string, evidence: string | null, fx: Fx, status: "failed" | "needs_reconcile" = "failed") {
  const s = getStep(stepId)!;
  const it = getItem(s.item_id)!;
  run("UPDATE step SET status = ?, failure_reason = ?, evidence = ? WHERE id = ?", status, reason, evidence, stepId);
  run("UPDATE item SET updated_at = ? WHERE id = ?", now(), it.id);
  log(stepId, s.status, status, "daycare", reason);
  fx.notes.push([`Stuck: ${it.slug}`, reason, false]);
}

function uniqueSlug(base: string): string {
  let slug = base;
  for (let i = 2; one("SELECT 1 FROM item WHERE slug = ?", slug); i++) slug = `${base}-${i}`;
  return slug;
}

export function createItem(opts: { title: string; repo: string; template?: string; prompt?: string; provider?: string; budget?: number; here?: boolean }): Item {
  const tpl = loadTemplate(opts.template ?? "quick");
  const repo = gitInfo(opts.repo).root ?? real(opts.repo);
  return txfx((fx) => {
    const slug = uniqueSlug(slugify(opts.title));
    const t = now();
    const id = Number(run("INSERT INTO item (slug, title, repo, here, template, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      slug, opts.title, repo, opts.here ? 1 : 0, tpl.name, t, t).lastInsertRowid);
    const vars = { title: opts.title, prompt: opts.prompt ?? opts.title, slug };
    tpl.steps.forEach((s: TemplateStep, i: number) => {
      run(`INSERT INTO step (item_id, idx, name, owner, provider, prompt, checklist, budget_usd, max_minutes) VALUES (?,?,?,?,?,?,?,?,?)`,
        id, i, s.name, s.owner, s.owner === "agent" ? (opts.provider ?? s.provider ?? null) : null,
        s.prompt ? render(s.prompt, vars) : null,
        s.checklist ? JSON.stringify(s.checklist.map((c) => ({ t: c, d: false }))) : null,
        s.owner === "agent" ? (opts.budget ?? s.budget_usd ?? null) : null, s.max_minutes ?? null);
    });
    const first = one<Step>("SELECT * FROM step WHERE item_id = ? ORDER BY idx LIMIT 1", id)!;
    enterStep(first.id, fx, "user");
    return getItem(id)!;
  });
}

// One git worktree per item, so helpers never write over each other or over you.
function ensureWorktree(it: Item): { path: string; error?: string } {
  if (it.worktree && existsSync(it.worktree)) return { path: it.worktree };
  const g = gitInfo(it.repo);
  if (!g.root || !config().worktrees || it.here) return { path: it.repo };
  const head = sh(["git", "-C", g.root, "rev-parse", "HEAD"]);
  if (!head.ok) return { path: it.repo, error: `${it.repo} has no commits yet, so Daycare can't make a worktree. Commit once, or use --here.` };
  const path = join(g.root, ".worktrees", `daycare-${it.slug}`);
  const branch = `daycare/${it.slug}`;
  // Keep the worktrees folder out of the main checkout's git status.
  const exclude = join(g.common!, "info", "exclude");
  try { if (!existsSync(exclude) || !readFileSync(exclude, "utf8").split("\n").includes(".worktrees/")) appendFileSync(exclude, "\n.worktrees/\n"); } catch {}
  let r = sh(["git", "-C", g.root, "worktree", "add", "-q", "-b", branch, path, "HEAD"], undefined, 60_000);
  if (!r.ok) r = sh(["git", "-C", g.root, "worktree", "add", "-q", path, branch], undefined, 60_000);
  if (!r.ok) return { path: it.repo, error: `Couldn't create a worktree: ${r.err || r.out}` };
  run("UPDATE item SET worktree = ?, branch = ?, base = ? WHERE id = ?", path, branch, head.out, it.id);
  return { path };
}

// Starts an agent step: records a worker and launches `daycare __run`, which supervises the
// tool, waits for it and records the outcome. Nothing here depends on hooks, so it works
// for any provider.
export function startStep(stepId: number) {
  const s = getStep(stepId);
  if (!s || s.status !== "active" || s.owner !== "agent") return;
  if (one("SELECT 1 FROM worker WHERE step_id = ? AND status IN ('starting','running')", stepId)) return;
  const it = getItem(s.item_id)!;
  const wt = ensureWorktree(it);
  if (wt.error) return txfx((fx) => failStep(stepId, "no worktree", wt.error!, fx));
  const g = gitInfo(wt.path);
  const provider = s.provider ?? config().providers.workers[0] ?? "claude";
  // A budget only means something if the tool can enforce it ({budget} in its argv).
  let capped = false;
  try { capped = !!loadProvider(provider).work?.argv.some((a) => a.includes("{budget}")); } catch {}
  const id = tx(() => {
    const t = now();
    // A follow-up continues the last run's conversation, so the session id moves to this run.
    if (s.followup_session) run("UPDATE worker SET session_id = NULL WHERE session_id = ?", s.followup_session);
    const wid = Number(run(`INSERT INTO worker (kind, provider, session_id, item_id, step_id, cwd, repo_root, repo_key, title, status, budget, started_at, last_event_at)
      VALUES ('dispatch', ?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?)`,
      provider, s.followup_session ?? crypto.randomUUID(), it.id, stepId, wt.path, wt.path, g.common ?? null, it.slug, capped ? s.budget_usd ?? config().budget_usd : null, t, t).lastInsertRowid);
    run("UPDATE worker SET out_path = ?, err_path = ? WHERE id = ?", join(P.runs, `${wid}.out`), join(P.runs, `${wid}.err`), wid);
    return wid;
  });
  const env = workerEnv(id);
  delete env.DAYCARE_WORKER; // only the tool itself carries the tag, not the supervisor
  const pid = spawnDetached(["__run", String(id)], env);
  run("UPDATE worker SET pid = ?, pid_started = ? WHERE id = ?", pid, pidStart(pid), id);
}

export const lastHelper = (itemId: number) =>
  one<Worker>("SELECT * FROM worker WHERE item_id = ? AND kind = 'dispatch' ORDER BY id DESC LIMIT 1", itemId);

// Can you send this task's helper a follow-up? Returns why not, or null if you can.
export function cantTell(it: Item): string | null {
  const w = lastHelper(it.id);
  if (!w?.session_id || !w.step_id) return `No helper has worked on ${it.slug} yet.`;
  try {
    const p = loadProvider(w.provider ?? "claude");
    return p.work?.follow_up ? null : `${p.label ?? p.name} can't continue a conversation (its provider file has no work.follow_up).`;
  } catch (e) { return (e as Error).message; }
}

// Sends a task's helper one more message. It continues the same conversation in the same
// worktree, then the task comes back to your desk. Mid-run, the message waits and goes out
// as soon as that run finishes.
export function tell(it: Item, text: string): string {
  const t = text.trim();
  if (!t) throw new Error("What should it do?");
  const why = cantTell(it);
  if (why) throw new Error(why);
  const w = lastHelper(it.id)!;
  if (w.status === "starting" || w.status === "running") {
    run("UPDATE item SET queued = CASE WHEN queued IS NULL THEN ? ELSE queued || char(10) || char(10) || ? END WHERE id = ?", t, t, it.id);
    return `Queued. ${it.slug} gets it when this run finishes.`;
  }
  const s = getStep(w.step_id!)!;
  txfx((fx) => {
    // Reopen the helper's step. Any later steps (your review, your test) come again after it.
    run("UPDATE step SET status = 'pending' WHERE item_id = ? AND idx > ? AND status != 'pending'", it.id, s.idx);
    run("UPDATE step SET followup = ?, followup_session = ? WHERE id = ?", [it.queued, t].filter(Boolean).join("\n\n"), w.session_id, s.id);
    run("UPDATE item SET status = 'active', reviewed_at = NULL, queued = NULL WHERE id = ?", it.id);
    enterStep(s.id, fx, "user");
  });
  return `Sent. ${it.slug} is on it.`;
}

// Which item does the user mean? An id, a slug, a slug prefix, or the item whose repo or
// worktree contains the current directory (longest match wins, on path-segment boundaries).
export function resolveItem(arg?: string, opts: { includeDone?: boolean } = {}): Item {
  const pool = all<Item>(`SELECT * FROM item ${opts.includeDone ? "" : "WHERE status = 'active' OR (status = 'done' AND reviewed_at IS NULL)"} ORDER BY updated_at DESC`);
  if (arg) {
    const exact = pool.find((i) => i.slug === arg || String(i.id) === arg);
    if (exact) return exact;
    const pre = pool.filter((i) => i.slug.startsWith(arg));
    if (pre.length === 1) return pre[0];
    if (pre.length > 1) throw new Error(`"${arg}" matches ${pre.map((i) => i.slug).join(", ")}. Be more specific.`);
    throw new Error(`No task called "${arg}". See \`daycare\` for the list.`);
  }
  const cwd = real(process.cwd());
  const hits = pool
    .map((i) => ({ i, len: Math.max(...[i.worktree, i.repo].filter(Boolean).map((p) => (cwd === p || cwd.startsWith(p + "/") ? p!.length : -1))) }))
    .filter((h) => h.len > 0)
    .sort((a, b) => b.len - a.len);
  if (hits.length && (hits.length === 1 || hits[0].len > hits[1].len)) return hits[0].i;
  if (hits.length) throw new Error(`Several tasks live here: ${hits.map((h) => h.i.slug).join(", ")}. Name one.`);
  throw new Error("Which task? Name one (see `daycare`), or run this inside its repo.");
}

// Throws a task away. Its worktree and branch go too, but only if they hold nothing:
// no commits and no uncommitted changes. Otherwise they stay, and the message says where.
export function discard(it: Item): string {
  const w = lastHelper(it.id);
  if (w && w.status !== "ended") {
    run("UPDATE worker SET kill_reason = COALESCE(kill_reason, 'discarded'), kill_evidence = COALESCE(kill_evidence, 'You discarded the task.') WHERE id = ?", w.id);
    if (w.child_pid) try { process.kill(w.child_pid, "SIGTERM"); } catch {}
  }
  tx(() => {
    for (const st of all<Step>("SELECT * FROM step WHERE item_id = ? AND status IN ('pending','active','failed','needs_reconcile')", it.id)) {
      run("UPDATE step SET status = 'cancelled' WHERE id = ?", st.id);
      log(st.id, st.status, "cancelled", "user", "discarded");
    }
    run("UPDATE item SET status = 'cancelled', queued = NULL, updated_at = ? WHERE id = ?", now(), it.id);
  });
  if (!it.worktree || !existsSync(it.worktree)) return `${it.slug} discarded.`;
  const commits = it.base ? Number(sh(["git", "-C", it.worktree, "rev-list", "--count", `${it.base}..HEAD`]).out || 0) : 1;
  const dirty = sh(["git", "-C", it.worktree, "status", "--porcelain"]).out.trim();
  if (commits || dirty) return `${it.slug} discarded. Its work is kept in ${it.worktree} (branch ${it.branch}).`;
  const r = sh(["git", "-C", it.repo, "worktree", "remove", it.worktree], undefined, 30_000);
  if (r.ok && it.branch) sh(["git", "-C", it.repo, "branch", "-D", it.branch]);
  return r.ok ? `${it.slug} discarded. It hadn't changed anything, so its worktree is gone too.` : `${it.slug} discarded. Its empty worktree is still at ${it.worktree}.`;
}
