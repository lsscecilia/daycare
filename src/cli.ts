#!/usr/bin/env bun
import { existsSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { act } from "./actions";
import { providerTemplate } from "./assets";
import { config } from "./config";
import { all, one, run } from "./db";
import { serve } from "./daemon";
import { hook } from "./hook";
import { activeStep, createItem, resolveItem, type Item } from "./items";
import { P } from "./paths";
import { printProbe, probe } from "./probe";
import { listProviders, loadProvider } from "./provider";
import { runWorker } from "./runner";
import { CLAUDE_SETTINGS, daemonUp, hooksSettings, hooksState, installDaemon, installHooks, installOcr, removeDaemon, removeHooks, writeDefaultConfig } from "./setup";
import { listTemplates } from "./templates";
import { addMessage, triage, type Message } from "./triage";
import { ago, copy, internalEnv, notify, now, sh, spawnDetached } from "./util";
import { view } from "./view";

const HELP = `daycare: see what your AI helpers are doing and what's waiting on you.

  daycare                         the board
  daycare ui                      open the room in your browser
  daycare run "<prompt>"          give a helper a job (own worktree, then you review)
      --repo <dir>  --here (no worktree)  --provider <name>  --budget <usd>
  daycare new "<title>" -t <template>   start a multi-step task (templates: daycare templates)

  daycare ok [task]               tick the next check, or finish your current step
  daycare approve [task]          finish your current step (skips the checklist)
  daycare review <task>           mark a finished task as looked at
  daycare retry <task>            run a stuck step again
  daycare resolve <task>          mark a stuck step as done anyway
  daycare kill <task>             stop a helper
  daycare tell <task> "<text>"    send a helper a follow-up (same conversation, same worktree)

  daycare snap [-m note]          screenshot a message; Daycare checks it and drafts a reply
  daycare drop [image] [-m note]  same, from a file or the clipboard
  daycare reply <n>               copy message n's draft reply
  daycare focus <minutes>|off     hold notifications except urgent ones

  daycare pause [task] [-m note]  save where you are
  daycare resume [task]           show where you were

  daycare setup                   install hooks, background daemon, screenshot reader
  daycare doctor                  check the install
  daycare uninstall               remove hooks and daemon (keeps ~/.daycare)
  daycare provider list|test <name> [--work]|new <name>
  daycare templates

A task can be named by its slug or number. Inside its repo or worktree you can leave it out.`;

const C = process.stdout.isTTY ? { dim: "\x1b[2m", b: "\x1b[1m", r: "\x1b[0m", red: "\x1b[31m", yel: "\x1b[33m", grn: "\x1b[32m", mag: "\x1b[35m" }
  : { dim: "", b: "", r: "", red: "", yel: "", grn: "", mag: "" };

function flag(args: string[], name: string, short?: string): string | undefined {
  const i = args.findIndex((a) => a === name || (short && a === short));
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}
function bool(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

function board() {
  const v = view();
  const st = v.stats;
  const focus = v.focus.until ? `   ${C.yel}focus: ${Math.ceil((v.focus.until - now()) / 60000)}m left, ${v.focus.held} held${C.r}` : "";
  console.log(`${C.b}DAYCARE${C.r}  ${st.working}/${st.helpers} helpers working · $${st.spent.toFixed(2)} today · ${st.doneToday} done today${focus}\n`);
  const sec = (title: string, rows: string[]) => { if (rows.length) console.log(`${C.b}${title}${C.r}\n${rows.join("\n")}\n`); };
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
  const hint = (s: string) => `${C.dim}${s}${C.r}`;

  sec("NEEDS YOU", v.cards.filter((c) => c.kind === "stuck").map((c) =>
    `  ${C.red}✗${C.r} ${pad(c.title, 24)} ${pad(c.sub ?? "", 38)} ${hint(`daycare retry ${c.item}`)}`));
  sec("MESSAGES", v.cards.filter((c) => c.kind === "msg").map((c) =>
    `  ${c.urgency === "P0" ? C.red : C.mag}✉${C.r} ${pad(`#${c.msg} ${c.urgency ?? ""} ${c.title}`, 24)} ${pad(c.sub ?? "", 38)} ${hint(c.failed ? `daycare reply ${c.msg}` : `daycare reply ${c.msg}`)}`));
  sec("YOUR TURN", v.cards.filter((c) => ["review", "test", "step"].includes(c.kind)).map((c) => {
    const detail = c.kind === "test" ? `${c.sub} ${c.checks!.filter((x) => x.d).length}/${c.checks!.length}` : c.kind === "review" ? `${c.sub}${c.changes ? ` · ${c.changes}` : ""}` : c.sub ?? "";
    return `  ${C.yel}●${C.r} ${pad(c.title, 24)} ${pad(detail, 38)} ${hint(`daycare ${c.kind === "test" ? "ok" : "approve"} ${c.item}`)}`;
  }));
  sec("HELPERS", v.helpers.map((h) => {
    const dot = h.state === "working" ? `${C.grn}●${C.r}` : h.state === "waiting" ? `${C.yel}●${C.r}` : h.state === "stuck" ? `${C.red}●${C.r}` : `${C.dim}●${C.r}`;
    const what = h.state === "waiting" ? (h.doing ? `your turn: ${h.doing}` : "your turn") : h.state === "idle" ? "idle" : h.doing ?? "working";
    const money = h.budget ? ` $${(h.spent ?? 0).toFixed(2)}/${h.budget.toFixed(2)}` : "";
    const lock = h.files.length ? ` 🔒${h.files.join(",")}` : "";
    return `  ${dot} ${pad(h.name, 10)} ${pad(h.task, 30)} ${pad(what, h.state === "waiting" ? 60 : 22)} ${hint(ago(h.since) + money + lock)}`;
  }));
  for (const c of v.conflicts) {
    const a = v.helpers.find((h) => h.id === c.a), b = v.helpers.find((h) => h.id === c.b);
    console.log(`  ${C.red}⚠ ${a?.task} and ${b?.task} are both changing ${c.file}${C.r}\n`);
  }
  sec("DONE, NOT REVIEWED", v.cards.filter((c) => c.kind === "done").map((c) =>
    `  ${C.grn}✓${C.r} ${pad(c.title, 24)} ${pad(c.changes ?? "finished", 38)} ${hint(`daycare review ${c.item}`)}`));
  if (v.reading) console.log(`  ${C.dim}Reading ${v.reading} message${v.reading > 1 ? "s" : ""}…${C.r}\n`);
  if (!v.cards.length && !v.helpers.length) console.log(`  Nothing going on. Start something with ${C.b}daycare run "<prompt>"${C.r}.\n`);
}

function showItem(it: Item) {
  const s = activeStep(it.id);
  console.log(`${C.b}${it.slug}${C.r}  ${it.title}`);
  if (it.worktree) console.log(`  worktree: ${it.worktree} (branch ${it.branch})`);
  if (s) console.log(`  now: ${s.name} (${s.owner === "me" ? "you" : "helper"}${s.status !== "active" ? `, ${s.status}` : ""})`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.shift() ?? "";

  switch (cmd) {
    case "": case "status": return board();
    case "help": case "-h": case "--help": return console.log(HELP);

    // Internal entry points.
    case "hook": return hook(args[0] ?? "");
    case "__run": return runWorker(Number(args[0]));
    case "__triage": return triage(Number(args[0]));
    case "daemon": return serve();

    case "run": {
      const repo = flag(args, "--repo") ?? process.cwd();
      const provider = flag(args, "--provider");
      const budget = flag(args, "--budget");
      const here = bool(args, "--here");
      const prompt = args.join(" ").trim();
      if (!prompt) throw new Error('What should the helper do? daycare run "fix the flaky cart test"');
      if (provider) loadProvider(provider);
      const it = createItem({ title: prompt.split("\n")[0].slice(0, 60), prompt, repo: resolve(repo), provider, budget: budget ? Number(budget) : undefined, here });
      const fresh = one<Item>("SELECT * FROM item WHERE id = ?", it.id)!;
      console.log(`Started ${C.b}${fresh.slug}${C.r}${fresh.worktree ? ` in ${fresh.worktree}` : ""}. Daycare will tell you when it's your turn.`);
      return;
    }
    case "new": {
      const template = flag(args, "-t") ?? flag(args, "--template") ?? "quick";
      const repo = flag(args, "--repo") ?? process.cwd();
      const prompt = flag(args, "-p") ?? flag(args, "--prompt");
      const provider = flag(args, "--provider");
      const here = bool(args, "--here");
      const title = args.join(" ").trim();
      if (!title) throw new Error('Give the task a title: daycare new "checkout bug" -t feature');
      const it = createItem({ title, template, prompt, repo: resolve(repo), provider, here });
      showItem(one<Item>("SELECT * FROM item WHERE id = ?", it.id)!);
      return;
    }
    case "ok": case "approve": case "review": case "retry": case "resolve": case "dispatch":
      return console.log(act({ action: cmd, item: resolveItem(args[0], { includeDone: cmd === "review" }).slug }));
    case "tell": {
      const item = args.shift();
      if (!item || !args.length) throw new Error('daycare tell <task> "what to do next"');
      return console.log(act({ action: "tell", item, text: args.join(" ") }));
    }
    case "kill": {
      const it = resolveItem(args[0]);
      const w = one<{ id: number }>("SELECT id FROM worker WHERE item_id = ? AND status != 'ended' ORDER BY id DESC LIMIT 1", it.id);
      if (!w) throw new Error(`No helper is running on ${it.slug}.`);
      return console.log(act({ action: "kill", worker: w.id }));
    }
    case "focus": {
      const a = args[0] ?? "";
      if (a === "off") return console.log(act({ action: "focus", minutes: 0 }));
      const m = Number(a || 25);
      if (!(m > 0)) throw new Error("daycare focus <minutes> or daycare focus off");
      return console.log(act({ action: "focus", minutes: m }));
    }

    case "snap": case "drop": {
      const note = flag(args, "-m");
      let file = args[0];
      if (cmd === "snap") {
        file = join(mkdtempSync(join(tmpdir(), "daycare-snap-")), "snap.png");
        const r = Bun.spawnSync(["screencapture", "-i", "-x", file]);
        if (r.exitCode !== 0 || !existsSync(file)) return; // cancelled with Esc
      } else if (!file) {
        file = join(mkdtempSync(join(tmpdir(), "daycare-clip-")), "clip.png");
        const r = sh(["osascript", "-e", `set f to open for access POSIX file "${file}" with write permission`, "-e", "write (the clipboard as «class PNGf») to f", "-e", "close access f"]);
        if (!r.ok) throw new Error("There's no image on the clipboard. Copy a screenshot first (⌃⇧⌘4), or pass a file.");
      }
      if (!existsSync(file)) throw new Error(`No such file: ${file}`);
      const id = addMessage(resolve(file), note);
      spawnDetached(["__triage", String(id)], internalEnv());
      notify("Daycare got it", "Checking the message…");
      return console.log(`Message #${id}: checking it. It'll show up on the board in a moment.`);
    }
    case "reply": {
      const id = Number(args[0]);
      const m = one<Message>("SELECT * FROM message WHERE id = ?", id);
      if (!m) throw new Error(`No message #${args[0]}.`);
      if (m.status === "failed") { console.log(`Couldn't read it: ${m.error}`); return console.log(act({ action: "dismiss", msg: id })); }
      if (m.status === "reading") throw new Error("Still checking it. Try again in a moment.");
      console.log(`${C.b}${m.sender ?? "Someone"}${C.r}: ${m.text}\n`);
      for (const f of JSON.parse(m.findings ?? "[]")) console.log(`  ✓ ${f.claim}\n    ${C.dim}$ ${f.command} → ${f.quote}${C.r}`);
      console.log(`\n${C.b}Draft:${C.r} ${m.draft}\n`);
      copy(m.draft ?? "");
      return console.log(act({ action: "reply", msg: id }));
    }

    case "pause": {
      const note = flag(args, "-m");
      const it = resolveItem(args[0]);
      const dir = it.worktree ?? it.repo;
      const w = one<{ session_id: string }>("SELECT session_id FROM worker WHERE item_id = ? ORDER BY id DESC LIMIT 1", it.id);
      run("INSERT INTO checkpoint (item_id, at, branch, head, status_porcelain, diff_stat, note, session_id) VALUES (?,?,?,?,?,?,?,?)",
        it.id, now(), sh(["git", "-C", dir, "branch", "--show-current"]).out, sh(["git", "-C", dir, "rev-parse", "--short", "HEAD"]).out,
        sh(["git", "-C", dir, "status", "--porcelain"]).out, sh(["git", "-C", dir, "diff", "--stat"]).out, note ?? null, w?.session_id ?? null);
      return console.log(`Saved where you are on ${it.slug}.${note ? "" : ' Tip: add -m "what you were about to do" next time.'}`);
    }
    case "resume": {
      const it = resolveItem(args[0]);
      const c = one<any>("SELECT * FROM checkpoint WHERE item_id = ? ORDER BY at DESC LIMIT 1", it.id);
      showItem(it);
      if (!c) return console.log("\nNo saved checkpoint. Use `daycare pause` before you switch away.");
      console.log(`\nSaved ${ago(c.at)} ago${c.note ? `: ${C.b}${c.note}${C.r}` : ""}`);
      if (c.diff_stat) console.log(`\n${c.diff_stat}`);
      console.log(`\n  cd ${it.worktree ?? it.repo}`);
      if (c.session_id) console.log(`  claude --resume ${c.session_id}`);
      return;
    }

    case "ui": {
      if (!(await daemonUp())) throw new Error("The daemon isn't running. Run `daycare setup`, or `daycare daemon` in another terminal.");
      sh(["open", `http://127.0.0.1:${config().port}/`]);
      return console.log(`Opened http://127.0.0.1:${config().port}/`);
    }

    case "setup": {
      const yes = bool(args, "--yes");
      const ask = (q: string) => yes || /^y/i.test(prompt(`${q} [y/N]`) ?? "");
      writeDefaultConfig();
      console.log(`${C.b}Daycare setup${C.r}  (data in ${P.config.replace(/\/config\.yaml$/, "")})\n`);

      const hasClaude = sh(["which", "claude"]).ok;
      console.log(`1. AI tool: ${hasClaude ? "Claude Code found." : "Claude Code not found."} Daycare uses "${config().providers.workers[0]}" for helpers and "${config().providers.messages}" for messages.`);
      console.log(`   To use your company's AI tool instead: daycare provider new <name>, then daycare provider test <name> --work.\n`);

      console.log(`2. Claude Code hooks let Daycare see every Claude session and lock files between them.`);
      console.log(`   This adds entries to ${CLAUDE_SETTINGS}, tagged so they can be removed (a backup is kept).`);
      if (bool(args, "--print-hooks")) console.log(JSON.stringify(hooksSettings(), null, 2));
      if (ask("   Install hooks?")) { const b = installHooks(); console.log(`   ✓ Hooks installed${b ? ` (backup: ${b})` : ""}.\n`); }
      else console.log("   Skipped. Daycare will only see helpers it starts itself.\n");

      console.log("3. Background daemon (serves the room UI and notices helpers that die).");
      if (ask("   Start it at login?")) {
        installDaemon();
        for (let i = 0; i < 20 && !(await daemonUp()); i++) await Bun.sleep(250);
        console.log((await daemonUp()) ? `   ✓ Running on http://127.0.0.1:${config().port}\n` : `   ✗ It didn't come up. See ${P.daemonLog}\n`);
      } else console.log("   Skipped. Run `daycare daemon` yourself when you want the UI.\n");

      console.log("4. Screenshot reader (Apple's text recognition, runs on your Mac).");
      const ocrErr = existsSync(P.ocr) ? null : installOcr();
      console.log(ocrErr ? `   ✗ ${ocrErr}\n` : "   ✓ Ready.\n");

      console.log("5. Notifications.");
      notify("Daycare", "If you can see this, notifications work.", true);
      if (!yes) {
        const saw = ask("   Did a notification just appear?");
        console.log(saw ? "   ✓ Good.\n" : "   Allow notifications for Script Editor in System Settings → Notifications.\n");
      }

      console.log(`${C.b}Next${C.r}`);
      console.log(`  daycare run "<what to do>"   give a helper a job`);
      console.log("  daycare ui                   open the room");
      console.log("  Screenshot shortcut: in the Shortcuts app, make a shortcut that runs the shell");
      console.log(`  command "${process.execPath.endsWith("bun") ? "daycare" : process.execPath} snap" and give it the key ⌃⌥T.`);
      return;
    }
    case "uninstall": {
      removeHooks();
      removeDaemon();
      return console.log(`Removed Daycare's hooks and daemon. Your data is still in ${P.config.replace(/\/config\.yaml$/, "")}.`);
    }
    case "doctor": {
      const fix = bool(args, "--fix");
      const hs = hooksState();
      console.log(`${hs === "ok" ? "✓" : "✗"} Claude Code hooks: ${hs}${hs !== "ok" ? (fix ? " → reinstalled" : " (daycare doctor --fix)") : ""}`);
      if (hs !== "ok" && fix) installHooks();
      const up = await daemonUp();
      console.log(`${up ? "✓" : "✗"} daemon: ${up ? `running on ${config().port}` : "not running (daycare setup)"}`);
      console.log(`${existsSync(P.ocr) ? "✓" : "✗"} screenshot reader: ${existsSync(P.ocr) ? P.ocr : "missing (daycare setup)"}`);
      for (const name of [...new Set([config().providers.messages, ...config().providers.workers])]) {
        try { const p = loadProvider(name); console.log(`✓ AI tool "${name}": ${p.label ?? name}${sh(["which", p.ask.argv[0]]).ok || existsSync(p.ask.argv[0]) ? "" : ` (but ${p.ask.argv[0]} isn't on PATH)`}`); }
        catch (e) { console.log(`✗ AI tool "${name}": ${(e as Error).message}`); }
      }
      const errs = existsSync(P.hookLog) ? Bun.file(P.hookLog).size : 0;
      if (errs) console.log(`! hook errors logged in ${P.hookLog}`);
      return;
    }
    case "provider": {
      const sub = args.shift();
      if (sub === "list") return console.log(listProviders().join("\n"));
      if (sub === "test") {
        const work = bool(args, "--work");
        const p = args[0]?.endsWith(".yaml") ? (await import("./provider")).loadProviderFile(args[0]) : loadProvider(args[0] ?? "claude");
        const res = await probe(p, { work });
        printProbe(p.label ?? p.name, res);
        process.exitCode = res.checks.some((c) => c.ok === false) ? 1 : 0;
        return;
      }
      if (sub === "new") {
        const name = args[0];
        if (!name || !/^[\w-]+$/.test(name)) throw new Error("daycare provider new <name>   (letters, numbers, dashes)");
        const file = join(P.providers, `${name}.yaml`);
        if (existsSync(file)) throw new Error(`${file} already exists.`);
        writeFileSync(file, providerTemplate.replace("name: my-company-ai", `name: ${name}`));
        return console.log(`Wrote ${file}. Fill it in (or ask your coding agent to use the daycare-connect skill), then: daycare provider test ${name} --work`);
      }
      throw new Error("daycare provider list | test <name> [--work] | new <name>");
    }
    case "templates": return console.log(listTemplates().join("\n"));
    case "hooks-json": return console.log(JSON.stringify(hooksSettings(), null, 2)); // for testing with claude --settings
    case "messages": {
      for (const m of all<Message>("SELECT * FROM message ORDER BY id DESC LIMIT 20"))
        console.log(`#${m.id} ${m.status.padEnd(8)} ${m.urgency ?? "  "} ${m.sender ?? ""} ${(m.text ?? m.error ?? "").slice(0, 60)}`);
      return;
    }
    default:
      throw new Error(`Unknown command "${cmd}". See daycare help.`);
  }
}

main().catch((e) => {
  console.error(`${C.red}${(e as Error).message}${C.r}`);
  process.exit(1);
});
