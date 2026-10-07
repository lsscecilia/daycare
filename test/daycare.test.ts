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
