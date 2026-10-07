// "Go to it": brings a Claude session's terminal to the front, so you can reply there.
// Daycare can't type into a running session; Claude Code has no way in for another program.
import type { Worker } from "./items";
import { sh } from "./util";

// Terminal and iTerm can select the exact tab by its tty. The tty comes in as an argument,
// never pasted into the script.
const SCRIPTS: Record<string, string> = {
  Terminal: `on run argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is item 1 of argv then
          set selected of t to true
          set index of w to 1
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "missing"
end run`,
  iTerm2: `on run argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is item 1 of argv then
            select w
            tell t to select
            tell s to select
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "missing"
end run`,
};

// The app a process runs in: the first ancestor whose executable lives inside a .app bundle.
function hostApp(pid: number): string | null {
  for (let i = 0; i < 12 && pid > 1; i++) {
    const [ppid, ...cmd] = sh(["ps", "-o", "ppid=,comm=", "-p", String(pid)]).out.trim().split(/\s+/);
    const m = cmd.join(" ").match(/^(.*?\.app)\/Contents\/MacOS\//);
    if (m) return m[1];
    pid = Number(ppid);
  }
  return null;
}

export function goTo(w: Worker): string {
  if (w.kind !== "session" || !w.pid) throw new Error("Daycare doesn't know which terminal that session is in.");
  const tty = sh(["ps", "-o", "tty=", "-p", String(w.pid)]).out.trim();
  const app = hostApp(w.pid);
  if (!app) throw new Error("That session isn't running any more.");
  const name = app.split("/").pop()!.replace(/\.app$/, "");
  const script = SCRIPTS[name];
  if (script && tty && tty !== "??") {
    const r = sh(["osascript", "-e", script, `/dev/${tty}`]);
    if (r.out === "ok") return `Switched to ${name}.`;
    if (/-1743|not allowed/i.test(r.err)) throw new Error(`Allow Daycare to control ${name}: System Settings → Privacy & Security → Automation.`);
  }
  // Any other app (VS Code, Cursor, Ghostty…): bring it to the front.
  sh(["open", "-a", app]);
  return `Switched to ${name}.`;
}
