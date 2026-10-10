import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Point Daycare at a throwaway home before any module reads it.
const home = mkdtempSync(join(tmpdir(), "daycare-test-"));
process.env.DAYCARE_HOME = home;
process.env.DAYCARE_NO_NOTIFY = "1";

let m: {
  triage: typeof import("../src/triage");
  provider: typeof import("../src/provider");
  items: typeof import("../src/items");
  actions: typeof import("../src/actions");
  view: typeof import("../src/view");
};

beforeAll(async () => {
  mkdirSync(join(home, "templates"), { recursive: true });
  writeFileSync(join(home, "templates", "manual.yaml"), `name: manual
steps:
  - name: deploy
    owner: me
  - name: test
    owner: me
    checklist: [log in, click checkout]
`);
  // Summaries come from a fake AI that answers with fixed JSON, once the prompt is read.
  mkdirSync(join(home, "providers"), { recursive: true });
  writeFileSync(join(home, "providers", "fake-notes.yaml"), `name: fake-notes
ask:
  argv: [sh, -c, 'cat >/dev/null; echo "{\\"tldr\\": \\"Fixed login bug\\", \\"points\\": [\\"a\\", \\"b\\", \\"c\\", \\"d\\"], \\"next\\": \\"Push to main?\\"}"']
`);
  writeFileSync(join(home, "config.yaml"), "providers:\n  notes: fake-notes\n");
  m = {
    triage: await import("../src/triage"),
    provider: await import("../src/provider"),
    items: await import("../src/items"),
    actions: await import("../src/actions"),
    view: await import("../src/view"),
  };
});

describe("urgency floor", () => {
  test("named incidents are P0", () => expect(m.triage.urgencyFloor("SEV1 on payments")).toBe("P0"));
  test("impact plus scope is P0 even without a keyword", () => expect(m.triage.urgencyFloor("checkout is throwing 500s for everyone??")).toBe("P0"));
  test("blocked is P1", () => expect(m.triage.urgencyFloor("I'm blocked on the deploy")).toBe("P1"));
  test("a casual ask is P2", () => expect(m.triage.urgencyFloor("can you look at my PR when you get a chance")).toBe("P2"));
});

describe("provider commands", () => {
  const cmd = { argv: ["tool", "--prompt", "{prompt}", "--id", "{session}"], prompt_via: "arg" as const };
  test("a prompt stays one argument, shell syntax and all", () => {
    const p = m.provider.prepare(cmd, `hi"; rm -rf ~ $(whoami)`, { session: "abc" });
    expect(p.argv).toEqual(["tool", "--prompt", `hi"; rm -rf ~ $(whoami)`, "--id", "abc"]);
    p.cleanup();
  });
  test("unknown placeholders are refused", () => {
    expect(() => m.provider.prepare({ argv: ["tool", "{nope}"] }, "x")).toThrow(/unknown placeholder/);
  });
  test("JSON results are read from stderr when the run fails (Claude Code does this)", () => {
    const out = { format: "json" as const, result: "result", error: "is_error", reason: "subtype", cost: "total_cost_usd" };
    const r = m.provider.parseOutput(out, "", '{"is_error":true,"subtype":"error_max_budget_usd","total_cost_usd":0.12}', 1);
    expect(r).toMatchObject({ isError: true, reason: "error_max_budget_usd", cost: 0.12 });
  });
  test("a non-zero exit is an error even if the JSON says success", () => {
    expect(m.provider.parseOutput({ format: "json", result: "r" }, '{"r":"ok"}', "", 2).isError).toBe(true);
  });
});

describe("a task with only your steps", () => {
  test("goes deploy → test checklist → done and reviewed", () => {
    const repo = mkdtempSync(join(tmpdir(), "daycare-repo-"));
    const it = m.items.createItem({ title: "Checkout bug", template: "manual", repo });
    expect(it.slug).toBe("checkout-bug");
    expect(m.view.view(false).cards.find((c) => c.item === "checkout-bug")?.kind).toBe("step");

    m.actions.act({ action: "approve", item: "checkout-bug" });
    let card = m.view.view(false).cards.find((c) => c.item === "checkout-bug")!;
    expect(card.kind).toBe("test");
    expect(card.checks!.map((c) => c.d)).toEqual([false, false]);

    expect(m.actions.act({ action: "ok", item: "checkout" })).toMatch(/Ticked: log in/); // prefix match
    m.actions.act({ action: "check", item: "checkout-bug", idx: 1, done: true });
    m.actions.act({ action: "ok", item: "checkout-bug" }); // nothing left to tick, so it finishes the step
    expect(m.items.resolveItem("checkout-bug", { includeDone: true }).status).toBe("done");
    expect(m.view.view(false).cards.find((c) => c.item === "checkout-bug")).toBeUndefined(); // you did the last step, so it's reviewed
  });

  test("the same title gets a unique slug", () => {
    const repo = mkdtempSync(join(tmpdir(), "daycare-repo-"));
    expect(m.items.createItem({ title: "Checkout bug", template: "manual", repo }).slug).toBe("checkout-bug-2");
  });

  test("a task you don't want is discarded straight off the board", () => {
    const repo = mkdtempSync(join(tmpdir(), "daycare-repo-"));
    const it = m.items.createItem({ title: "oops typed in the wrong box", template: "manual", repo });
    expect(m.actions.act({ action: "discard", item: it.slug })).toMatch(/discarded/);
    expect(m.view.view(false).cards.find((c) => c.item === it.slug)).toBeUndefined();
    expect(() => m.actions.act({ action: "discard", item: it.slug })).toThrow(/No task/);
  });

  test("approving something that isn't waiting on you is refused", () => {
    expect(() => m.actions.act({ action: "review", item: "checkout-bug-2" })).toThrow(/isn't finished/);
  });
});

describe("finding the task from the current directory", () => {
  test("matches on path segments, not string prefixes", () => {
    const base = mkdtempSync(join(tmpdir(), "daycare-seg-"));
    mkdirSync(join(base, "proj")); mkdirSync(join(base, "project-two"));
    m.items.createItem({ title: "seg test", template: "manual", repo: join(base, "proj") });
    const cwd = process.cwd();
    try {
      process.chdir(join(base, "project-two"));
      expect(() => m.items.resolveItem()).toThrow(/Which task/);
      process.chdir(join(base, "proj"));
      expect(m.items.resolveItem().slug).toBe("seg-test");
    } finally { process.chdir(cwd); }
  });
});

describe("process liveness", () => {
  test("a pid's start time reads the same whatever the caller's locale", async () => {
    const util = await import("../src/util");
    const mine = util.pidStart(process.pid)!;
    const lang = process.env.LANG;
    try {
      process.env.LANG = "en_SG.UTF-8";
      expect(util.pidStart(process.pid)).toBe(mine);
      expect(util.alive(process.pid, mine)).toBe(true);
    } finally { process.env.LANG = lang; }
  });
});

describe("what a stopped session needs from you", () => {
  test("its last question, without markdown", async () => {
    const { brief } = await import("../src/hook");
    expect(brief("Fixed. All **13 tests** pass.\n\n| a | b |\n|---|---|\n\nWant me to push `main`?")).toBe("Want me to push main?");
  });
  test("otherwise its opening line; file names don't split sentences", async () => {
    const { brief } = await import("../src/hook");
    expect(brief("Installed with ./install.sh and restarted the daemon. Refresh the tab.")).toBe("Installed with ./install.sh and restarted the daemon.");
    expect(brief("```\ncode\n```")).toBeNull();
  });
});

describe("a long reply, summarized for the room", () => {
  const said = "Done. ".repeat(60) + "Want me to push?";
  async function waiting() {
    const { run } = await import("../src/db");
    const t = Date.now();
    return Number(run("INSERT INTO worker (kind, session_id, title, status, said, started_at) VALUES ('session', ?, 'x', 'waiting', ?, ?)", `s${t}${Math.random()}`, said, t).lastInsertRowid);
  }
  test("only long replies need one", async () => {
    const { needsSummary } = await import("../src/summarize");
    expect(needsSummary("Done.")).toBe(false);
    expect(needsSummary(said)).toBe(true);
  });
  test("a few words, at most three points, and what you need to do", async () => {
    const { summarize } = await import("../src/summarize");
    const id = await waiting();
    await summarize(id);
    const h = m.view.view(false).helpers.find((x) => x.id === id)!;
    expect(h.summary).toEqual({ tldr: "Fixed login bug", points: ["a", "b", "c"], next: "Push to main?" });
  });
  test("dropped if you've already replied", async () => {
    const { summarize } = await import("../src/summarize");
    const { one, run } = await import("../src/db");
    const id = await waiting();
    const p = summarize(id);
    run("UPDATE worker SET status = 'running', said = NULL WHERE id = ?", id);
    await p;
    expect(one<{ summary: string | null }>("SELECT summary FROM worker WHERE id = ?", id)?.summary).toBeNull();
  });
});

describe("typing a reply into a terminal session", () => {
  const w = (o: object) => ({ kind: "session", status: "waiting", pid: null, pid_started: null, ...o }) as any;
  test("only on its turn, so Return can't answer a permission question", async () => {
    const { typeInto } = await import("../src/goto");
    expect(() => typeInto(w({ status: "running" }), "hi")).toThrow(/busy/);
    expect(() => typeInto(w({ kind: "dispatch" }), "hi")).toThrow(/through Daycare/);
    expect(() => typeInto(w({}), "  \n ")).toThrow(/Type something/);
  });
  test("never into a terminal whose session is gone", async () => {
    const { typeInto } = await import("../src/goto");
    expect(() => typeInto(w({ pid: 999999 }), "hi")).toThrow(/isn't running/);
  });
});

describe("what a session cost", () => {
  test("each reply is counted once, at its model's price, cache writes and reads included", async () => {
    const { transcriptCost } = await import("../src/cost");
    const dir = mkdtempSync(join(tmpdir(), "daycare-cost-"));
    const usage = { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 100_000, ephemeral_1h_input_tokens: 0 } };
    const line = (id: string, model: string, u = usage) => JSON.stringify({ timestamp: new Date().toISOString(), message: { id, model, usage: u } });
    // The same reply logged twice (one line per content block), plus one sub-agent reply.
    writeFileSync(join(dir, "s.jsonl"), [line("a", "claude-opus-5-5"), line("a", "claude-opus-5-5"), JSON.stringify({ type: "user" })].join("\n"));
    mkdirSync(join(dir, "s", "subagents"), { recursive: true });
    writeFileSync(join(dir, "s", "subagents", "agent-1.jsonl"), line("b", "claude-haiku-4-5", { input_tokens: 1_000_000, output_tokens: 0 } as any));
    const { total, byDay } = transcriptCost(join(dir, "s.jsonl"));
    // Opus 5.5: 1k in × $4 + 1k out × $20 + 1M cache read × $0.20 + 100k 5-min write × $4 × 1.25 = 0.004 + 0.02 + 0.2 + 0.5
    // Haiku 4.5: 1M in × $1 = 1
    expect(total).toBeCloseTo(1.724, 6);
    expect([...byDay.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1.724, 6);
  });
  test("fast mode costs double", async () => {
    const { replyCost } = await import("../src/cost");
    expect(replyCost("claude-opus-5-5", { input_tokens: 1e6, output_tokens: 0, speed: "fast" })).toBeCloseTo(8, 6);
  });
});

describe("the room's command box", () => {
  test("plain text is a job for a helper, kept exactly as typed", async () => {
    const { toArgv } = await import("../src/command");
    expect(toArgv(`  fix the "flaky" cart test  `)).toEqual(["run", `fix the "flaky" cart test`]);
  });
  test("daycare commands are split like a shell would, quotes only", async () => {
    const { toArgv } = await import("../src/command");
    expect(toArgv(`daycare new "checkout bug" -t feature`)).toEqual(["new", "checkout bug", "-t", "feature"]);
    expect(toArgv(`daycare run 'echo $(whoami)'`)).toEqual(["run", "echo $(whoami)"]);
  });
  test("commands that change your machine stay in the terminal", async () => {
    const { toArgv } = await import("../src/command");
    for (const c of ["daycare setup", "daycare uninstall", "daycare hook Stop", "daycare __run 1", "daycare daemon"]) expect(() => toArgv(c)).toThrow(/terminal/);
    expect(() => toArgv(`daycare run "oops`)).toThrow(/quote/);
  });
});
