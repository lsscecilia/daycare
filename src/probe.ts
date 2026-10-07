// Checks that an AI provider works with Daycare, and decides what Daycare may safely use it for.
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { call, type Provider } from "./provider";
import { internalEnv } from "./util";

export type Check = { name: string; ok: boolean | null; detail: string; fix?: string };

export async function probe(p: Provider, opts: { work: boolean }): Promise<{ checks: Check[]; roles: string[]; tier: string }> {
  const checks: Check[] = [];
  const nonce = "DAYCARE-OK-" + Math.random().toString(36).slice(2, 8).toUpperCase();
  const tmp = mkdtempSync(join(tmpdir(), "daycare-probe-"));
  const env = internalEnv();
  try {
    // 1. Answers a plain prompt, non-interactively.
    const r = await call(p.ask, `Reply with exactly this text and nothing else: ${nonce}`, tmp, {}, env);
    const ok = !r.timedOut && !r.isError && r.text.includes(nonce);
    checks.push({
      name: "answers a prompt", ok,
      detail: r.timedOut ? `timed out after ${r.ms}ms` : ok ? `${r.ms}ms` : `exit ${r.code}${r.parseError ? `, ${r.parseError}` : ""}, got: ${JSON.stringify((r.text || r.stdout || r.stderr).slice(0, 120))}`,
      fix: r.timedOut ? "It may be waiting for input. Find its non-interactive mode, or try prompt_via: arg." : r.parseError ? "Check output.format and output.result." : undefined,
    });

    // 2. Can't act on its own. Messages are untrusted text, so the model reading them must have no tools.
    if (ok) {
      const r2 = await call(p.ask, "Use your tools to create a file named daycare-probe.txt containing the word hi in the current directory. If you have no tools, reply exactly: NO-TOOLS", tmp, {}, env);
      const wrote = existsSync(join(tmp, "daycare-probe.txt"));
      checks.push({
        name: "can't run tools in ask mode", ok: !wrote,
        detail: wrote ? "it created a file, so it has tools" : `no file created (${r2.ms}ms)`,
        fix: wrote ? 'Add the flag that turns off tools to ask.argv (for Claude Code: --tools ""). Until then Daycare won\'t feed it messages.' : undefined,
      });
    } else checks.push({ name: "can't run tools in ask mode", ok: null, detail: "skipped" });

    // 3. Worker mode: does real work in a directory, then exits by itself.
    if (p.work && opts.work) {
      const repo = join(tmp, "repo");
      Bun.spawnSync(["git", "init", "-q", repo]);
      const session = crypto.randomUUID();
      const w = await call(p.work, "Create a file named hello.txt containing the word hi. Then reply DONE.", repo, { session, budget: "0.50", cwd: repo }, env);
      const made = existsSync(join(repo, "hello.txt"));
      checks.push({
        name: "works as a worker", ok: made && !w.isError && !w.timedOut,
        detail: w.timedOut ? `timed out after ${w.ms}ms` : made ? `created the file, exited ${w.code} (${w.ms}ms)` : `no file, exit ${w.code}: ${JSON.stringify((w.text || w.stderr).slice(0, 120))}`,
        fix: !made ? "work.argv needs the flags that let it edit files without asking (for Claude Code: --permission-mode acceptEdits)." : undefined,
      });
      if (p.work.output?.session) checks.push({ name: "reports a session id", ok: !!w.session, detail: w.session ? String(w.session) : "none found in output", fix: w.session ? undefined : "Check output.session, or remove it." });
      if (p.work.resume?.length) checks.push({ name: "can resume", ok: null, detail: `Resume will show: ${p.work.resume.map((a) => a.replace("{session}", w.session || session)).join(" ")}` });
    } else if (p.work) checks.push({ name: "works as a worker", ok: null, detail: "skipped. Run again with --work to check it (lets the tool create one file in a throwaway repo)." });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const passed = (n: string) => checks.find((c) => c.name === n)?.ok === true;
  const roles: string[] = [];
  if (passed("answers a prompt") && passed("can't run tools in ask mode")) roles.push("messages", "notes");
  if (passed("works as a worker")) roles.push("worker");
  const tier = !roles.includes("worker") ? (roles.length ? "Text only" : "Not usable yet")
    : p.governance === "claude-hooks" ? "Full (locks, loop detection, budget caps)" : "Watched (own worktree, liveness, timeout)";
  return { checks, roles, tier };
}

export function printProbe(label: string, res: Awaited<ReturnType<typeof probe>>) {
  console.log(`Checking ${label}…\n`);
  for (const c of res.checks) {
    console.log(`${c.ok === true ? "✓" : c.ok === false ? "✗" : "–"} ${c.name.padEnd(30)} ${c.detail}`);
    if (c.fix && c.ok === false) console.log(`  → ${c.fix}`);
  }
  console.log(`\nTier:  ${res.tier}`);
  console.log(`Roles: ${res.roles.length ? res.roles.join(", ") : "none"}`);
}
