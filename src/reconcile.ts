// Notices things that ended without telling anyone: a supervisor killed with -9, a laptop
// reboot, a terminal closed mid-session. Runs in the daemon every few seconds, and before
// every `daycare` board, so the board is right even when the daemon isn't running.
import { all, kvGet, kvSet, run, tx } from "./db";
import { failStep, getStep, txfx, type Worker } from "./items";
import { alive, focusUntil, notify, now } from "./util";

const DAY = 24 * 3600_000;

export function reconcile() {
  for (const w of all<Worker>("SELECT * FROM worker WHERE status != 'ended'")) {
    if (w.kind === "dispatch") {
      const supervisorUp = alive(w.pid, w.pid_started);
      const toolUp = alive(w.child_pid);
      const stale = w.status === "starting" && !w.pid && now() - w.started_at > 60_000;
      if ((supervisorUp || toolUp) && !stale) continue;
      txfx((fx) => {
        run("UPDATE worker SET status = 'ended', ended_at = ? WHERE id = ?", now(), w.id);
        run("DELETE FROM lock WHERE worker_id = ?", w.id);
        const s = w.step_id ? getStep(w.step_id) : null;
        if (s?.status === "active") failStep(s.id, "stopped unexpectedly",
          "The helper's process went away without reporting back (crash, reboot or kill -9). Check its worktree, then retry or mark it done.", fx, "needs_reconcile");
      });
    } else {
      // A Claude session. If its process is gone, or it's been silent for a day, it's over.
      const gone = w.pid ? !alive(w.pid, w.pid_started) : now() - (w.last_event_at ?? w.started_at) > DAY;
      if (gone) tx(() => {
        run("UPDATE worker SET status = 'ended', ended_at = ? WHERE id = ?", now(), w.id);
        run("DELETE FROM lock WHERE worker_id = ?", w.id);
      });
    }
  }
  // Focus ended: one notification for everything that was held.
  const until = Number(kvGet("focus_until") || 0);
  if (until && !focusUntil()) {
    const held = Number(kvGet("focus_held") || 0);
    tx(() => { kvSet("focus_until", null); kvSet("focus_held", null); });
    notify("Focus over", held ? `${held} thing${held > 1 ? "s" : ""} came in while you were focusing.` : "Nothing new came in.", true);
  }
}
