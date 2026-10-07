// `daycare __run <worker>`: supervises one helper run. Launched detached by startStep, it
// starts the tool, waits for it to exit, and records how it went. Because the outcome
// comes from the exit itself, completion works for every provider, hooks or not.
import { spawn } from "child_process";
import { closeSync, openSync, readFileSync } from "fs";
import { config } from "./config";
import { run } from "./db";
import { completeStep, failStep, getItem, getStep, getWorker, txfx } from "./items";
import { loadProvider, parseOutput, prepare } from "./provider";
import { render } from "./templates";
import { now, sh, workerEnv } from "./util";

const tail = (s: string, n = 600) => (s.length > n ? "…" + s.slice(-n) : s).trim();

export async function runWorker(workerId: number) {
  const w = getWorker(workerId);
  if (!w || w.status !== "starting") return;
  const s = getStep(w.step_id!)!;
  const it = getItem(w.item_id!)!;
  const finishFail = (reason: string, evidence: string) =>
    txfx((fx) => {
      run("UPDATE worker SET status = 'ended', ended_at = ? WHERE id = ?", now(), w.id);
      run("DELETE FROM lock WHERE worker_id = ?", w.id);
      if (getStep(s.id)!.status === "active") failStep(s.id, reason, evidence, fx);
    });

  let provider;
  try { provider = loadProvider(w.provider!); } catch (e) { return finishFail("no such AI tool", (e as Error).message); }
  if (!provider.work) return finishFail("can't work", `${provider.label ?? provider.name} has no "work" section, so it can only read messages.`);

  let prompt = render(s.prompt ?? it.title, { title: it.title, slug: it.slug, prompt: it.title });
  if (it.branch) prompt += `\n\n(You're in a git worktree on branch ${it.branch}. Commit your changes with a clear message when you're done.)`;

  let prepared;
  try { prepared = prepare(provider.work, prompt, { session: w.session_id!, budget: String(w.budget ?? s.budget_usd ?? config().budget_usd), cwd: w.cwd! }); }
  catch (e) { return finishFail("bad provider config", (e as Error).message); }

  const out = openSync(w.out_path!, "w");
  const err = openSync(w.err_path!, "w");
  const child = spawn(prepared.argv[0], prepared.argv.slice(1), {
    cwd: w.cwd!, env: workerEnv(w.id), stdio: [prepared.stdin !== null ? "pipe" : "ignore", out, err],
  });
  child.on("error", () => {}); // reported through the exit below
  if (prepared.stdin !== null) child.stdin!.end(prepared.stdin);
  run("UPDATE worker SET status = 'running', child_pid = ?, last_event_at = ? WHERE id = ?", child.pid ?? null, now(), w.id);

  const limitMs = (s.max_minutes ? s.max_minutes * 60 : provider.work.timeout_seconds ?? 3600) * 1000;
  const timer = setTimeout(() => {
    run("UPDATE worker SET kill_reason = 'timeout', kill_evidence = ? WHERE id = ? AND kill_reason IS NULL",
      `Still running after ${Math.round(limitMs / 60000)} minutes.`, w.id);
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 10_000);
  }, limitMs);

  const code: number | null = await new Promise((res) => {
    child.on("exit", (c) => res(c));
    child.on("error", (e) => { run("UPDATE worker SET kill_reason = 'could not start', kill_evidence = ? WHERE id = ?", String(e.message), w.id); res(null); });
  });
  clearTimeout(timer);
  closeSync(out); closeSync(err);
  prepared.cleanup();

  const stdout = readFileSync(w.out_path!, "utf8");
  const stderr = readFileSync(w.err_path!, "utf8");
  const parsed = parseOutput(provider.work.output, stdout, stderr, code);

  // Summarise what changed in the worktree, for the review card.
  let changes = "";
  if (it.base && w.cwd) {
    const commits = Number(sh(["git", "-C", w.cwd, "rev-list", "--count", `${it.base}..HEAD`]).out || 0);
    const files = new Set(sh(["git", "-C", w.cwd, "diff", "--name-only", it.base]).out.split("\n").filter(Boolean));
    for (const l of sh(["git", "-C", w.cwd, "status", "--porcelain"]).out.split("\n")) if (l.trim()) files.add(l.slice(3));
    changes = [commits ? `${commits} commit${commits === 1 ? "" : "s"}` : "", files.size ? `${files.size} file${files.size === 1 ? "" : "s"} changed` : "no changes"]
      .filter(Boolean).join(", ");
  }

  txfx((fx) => {
    const cur = getWorker(w.id)!;
    run("UPDATE worker SET status = 'ended', ended_at = ?, spent = COALESCE(?, spent), session_id = COALESCE(?, session_id) WHERE id = ?",
      now(), parsed.cost ?? null, parsed.session ?? null, w.id);
    run("DELETE FROM lock WHERE worker_id = ?", w.id);
    if (getStep(s.id)!.status !== "active") return; // resolved by the user meanwhile
    if (cur.kill_reason) failStep(s.id, cur.kill_reason, cur.kill_evidence, fx);
    else if (parsed.isError) failStep(s.id, parsed.reason && parsed.reason !== "success" ? parsed.reason : code === null ? "couldn't start" : `exit ${code}`,
      tail(parsed.text || parsed.parseError || stderr || stdout) || null, fx);
    else completeStep(s.id, fx, "daycare", JSON.stringify({ text: tail(parsed.text, 1200), changes }));
  });
}
