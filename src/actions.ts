// Everything you can do to a task or message. The CLI and the room UI both call these.
import { kvGet, kvSet, one, run, tx } from "./db";
import { goTo, typeInto } from "./goto";
import { activeStep, checks, completeStep, discard, enterStep, getWorker, resolveItem, startStep, tell, txfx } from "./items";
import { reconcile } from "./reconcile";
import { now } from "./util";

export type Action =
  | { action: "ok" | "approve" | "review" | "retry" | "resolve" | "dispatch" | "discard"; item: string }
  | { action: "check"; item: string; idx: number; done: boolean }
  | { action: "kill" | "hide" | "goto"; worker: number }
  | { action: "tell"; item: string; text: string }
  | { action: "type"; worker: number; text: string }
  | { action: "reply" | "dismiss"; msg: number }
  | { action: "focus"; minutes: number };

export function act(a: Action): string {
  switch (a.action) {
    case "ok": {
      const it = resolveItem(a.item);
      const s = activeStep(it.id);
      if (!s || s.owner !== "me" || s.status !== "active") throw new Error(`${it.slug} isn't waiting on you.`);
      const cl = checks(s);
      const next = cl.findIndex((c) => !c.d);
      if (next >= 0) {
        cl[next].d = true;
        run("UPDATE step SET checklist = ? WHERE id = ?", JSON.stringify(cl), s.id);
        return `Ticked: ${cl[next].t}${cl.every((c) => c.d) ? ". All checks done. Run it again to finish the step." : ""}`;
      }
      txfx((fx) => completeStep(s.id, fx, "user"));
      return `${it.slug}: "${s.name}" done.`;
    }
    case "check": {
      const it = resolveItem(a.item);
      const s = activeStep(it.id);
      if (!s || s.owner !== "me") throw new Error(`${it.slug} isn't waiting on you.`);
      const cl = checks(s);
      if (!cl[a.idx]) throw new Error("No such check.");
      cl[a.idx].d = a.done;
      run("UPDATE step SET checklist = ? WHERE id = ?", JSON.stringify(cl), s.id);
      return "Saved.";
    }
    case "approve": {
      const it = resolveItem(a.item);
      const s = activeStep(it.id);
      if (!s || s.owner !== "me" || s.status !== "active") throw new Error(`${it.slug} isn't waiting on you.`);
      txfx((fx) => completeStep(s.id, fx, "user"));
      return `${it.slug}: "${s.name}" done.`;
    }
    case "review": {
      const it = resolveItem(a.item);
      if (it.status !== "done") throw new Error(`${it.slug} isn't finished yet.`);
      run("UPDATE item SET reviewed_at = ?, updated_at = ? WHERE id = ?", now(), now(), it.id);
      return `${it.slug} is off the board.`;
    }
    case "retry": {
      const it = resolveItem(a.item);
      const s = activeStep(it.id);
      if (!s || (s.status !== "failed" && s.status !== "needs_reconcile")) throw new Error(`${it.slug} isn't stuck.`);
      txfx((fx) => enterStep(s.id, fx, "user"));
      return s.owner === "agent" ? `${it.slug}: starting again.` : `${it.slug}: back on your desk.`;
    }
    case "resolve": {
      const it = resolveItem(a.item);
      const s = activeStep(it.id);
      if (!s || (s.status !== "failed" && s.status !== "needs_reconcile")) throw new Error(`${it.slug} isn't stuck.`);
      txfx((fx) => completeStep(s.id, fx, "user"));
      return `${it.slug}: marked "${s.name}" as done.`;
    }
    case "discard": {
      const it = resolveItem(a.item);
      if (it.status !== "active") throw new Error(`${it.slug} is already finished. Use review to clear it.`);
      return discard(it);
    }
    case "dispatch": {
      const it = resolveItem(a.item);
      const s = activeStep(it.id);
      if (!s || s.owner !== "agent" || s.status !== "active") throw new Error(`${it.slug} has no helper step to start.`);
      startStep(s.id);
      return `${it.slug}: helper started.`;
    }
    case "kill": {
      const w = getWorker(a.worker);
      if (!w || w.status === "ended") throw new Error("That helper isn't running.");
      if (w.kind !== "dispatch") throw new Error("That's one of your own Claude sessions. Stop it in its terminal.");
      run("UPDATE worker SET kill_reason = COALESCE(kill_reason, 'stopped by you'), kill_evidence = COALESCE(kill_evidence, 'You stopped it.') WHERE id = ?", w.id);
      for (const pid of [w.child_pid]) if (pid) try { process.kill(pid, "SIGTERM"); } catch {}
      return `Stopping ${w.title}.`;
    }
    case "tell":
      return tell(resolveItem(a.item, { includeDone: true }), a.text);
    case "goto": {
      const w = getWorker(a.worker);
      if (!w || w.status === "ended") throw new Error("That session has ended.");
      return goTo(w);
    }
    case "type": {
      const w = getWorker(a.worker);
      if (!w || w.status === "ended") throw new Error("That session has ended.");
      return typeInto(w, a.text);
    }
    case "hide": {
      const w = getWorker(a.worker);
      if (!w) throw new Error("No such helper.");
      if (w.kind === "dispatch") throw new Error("Stop a helper with kill instead.");
      tx(() => { run("UPDATE worker SET status = 'ended', ended_at = ? WHERE id = ?", now(), w.id); run("DELETE FROM lock WHERE worker_id = ?", w.id); });
      return "Hidden. It comes back if the session does anything.";
    }
    case "reply":
    case "dismiss": {
      if (!one("SELECT 1 FROM message WHERE id = ?", a.msg)) throw new Error("No such message.");
      run("UPDATE message SET status = 'done', updated_at = ? WHERE id = ?", now(), a.msg);
      return a.action === "reply" ? "Reply copied. Paste it where the message came from." : "Dismissed.";
    }
    case "focus": {
      if (a.minutes > 0) {
        tx(() => { kvSet("focus_until", String(now() + a.minutes * 60_000)); kvSet("focus_held", "0"); });
        return `Focus on for ${a.minutes} minutes. Only urgent things get through.`;
      }
      if (!kvGet("focus_until")) return "Focus is already off.";
      tx(() => kvSet("focus_until", String(now() - 1)));
      reconcile();
      return "Focus off.";
    }
  }
}

