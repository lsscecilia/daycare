// "Go to it": brings a Claude session's terminal to the front, so you can reply there.
// "Type to it": types your reply into that terminal tab, as if you'd typed it yourself.
import type { Worker } from "./items";
import { alive, sh } from "./util";

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

// Typing: Terminal's `do script` and iTerm's `write text` send the text to the tab's foreground
// process, followed by Return. Text and tty are arguments, never pasted into the script.
const TYPE: Record<string, string> = {
  Terminal: `on run argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is item 1 of argv then
          do script (item 2 of argv) in t
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
            tell s to write text (item 2 of argv)
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

// Types a reply into a hand-started session's terminal. Only when it's your turn: then Claude
// is at its input prompt. Mid-turn, the Return could answer a permission question instead.
export function typeInto(w: Worker, text: string): string {
  const said = text.replace(/\s*\n\s*/g, " ").trim(); // a newline would send early
  if (!said) throw new Error("Type something first.");
  if (w.kind !== "session") throw new Error("That helper takes messages through Daycare, not its terminal.");
  if (w.status !== "waiting") throw new Error("It's busy. Wait for its turn, or use Go to it.");
  if (!w.pid || !alive(w.pid, w.pid_started)) throw new Error("That session isn't running any more.");
  const tty = sh(["ps", "-o", "tty=", "-p", String(w.pid)]).out.trim();
  if (!tty || tty === "??") throw new Error("Daycare can't find that session's terminal. Use Go to it.");
  // Claude itself must have the keyboard: never type into a shell or into something it launched.
  const front = sh(["ps", "-t", tty, "-o", "pid=,stat="]).out.split("\n").filter((l) => l.includes("+")).map((l) => Number(l.trim().split(/\s+/)[0]));
  if (!front.includes(w.pid)) throw new Error("Claude isn't at its prompt in that terminal. Use Go to it.");
  const app = hostApp(w.pid);
  const name = app?.split("/").pop()!.replace(/\.app$/, "") ?? "";
  const script = TYPE[name];
  if (!script) throw new Error(`Daycare can type into Terminal and iTerm, not ${name || "this app"}. Use Go to it.`);
  const r = sh(["osascript", "-e", script, `/dev/${tty}`, said]);
  if (r.out === "ok") return "Sent.";
  if (/-1743|not allowed/i.test(r.err)) throw new Error(`Allow Daycare to control ${name}: System Settings → Privacy & Security → Automation.`);
  throw new Error("Couldn't find that terminal tab. Use Go to it.");
}
