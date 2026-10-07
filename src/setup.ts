// Installing and removing Daycare: Claude Code hooks, the background daemon, the screenshot reader.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { ocrSwift } from "./assets";
import { CONFIG_TEMPLATE, config } from "./config";
import { ensureDirs, HOME, P } from "./paths";
import { selfArgv, sh } from "./util";

export const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
const TAG = "_daycare_source";
const LABEL = "dev.daycare.daemon";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

const EVENTS: [string, string?][] = [
  ["SessionStart"], ["UserPromptSubmit"], ["PreToolUse", "Edit|Write|MultiEdit|NotebookEdit"],
  ["PostToolUse"], ["Stop"], ["StopFailure"], ["SessionEnd"],
];

const q = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const envPrefix = () => (process.env.DAYCARE_HOME ? `DAYCARE_HOME=${q(process.env.DAYCARE_HOME)} ` : "");
export const hookCommand = (event: string) => `${envPrefix()}${selfArgv().map(q).join(" ")} hook ${event}`;

export function hooksSettings() {
  const hooks: Record<string, unknown[]> = {};
  for (const [ev, matcher] of EVENTS)
    hooks[ev] = [{ [TAG]: "daycare", ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: hookCommand(ev), timeout: 5 }] }];
  return { hooks };
}

function readSettings(file: string): any {
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error(`${file} isn't valid JSON, so Daycare won't touch it. Fix it and run setup again.`); }
}
function writeAtomic(file: string, data: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.daycare-tmp`, data);
  renameSync(`${file}.daycare-tmp`, file);
}

// Adds Daycare's hooks next to whatever is already there. Re-running replaces only Daycare's own
// entries (found by their tag), so it's safe to repeat, and safe after another tool rewrites the file.
export function installHooks(file = CLAUDE_SETTINGS): string | null {
  const s = readSettings(file);
  let backup: string | null = null;
  if (existsSync(file)) { backup = `${file}.before-daycare`; if (!existsSync(backup)) copyFileSync(file, backup); }
  s.hooks ??= {};
  const ours = hooksSettings().hooks;
  for (const [ev, entries] of Object.entries(ours)) s.hooks[ev] = [...(s.hooks[ev] ?? []).filter((e: any) => !e?.[TAG]), ...entries];
  writeAtomic(file, JSON.stringify(s, null, 2) + "\n");
  return backup;
}

export function removeHooks(file = CLAUDE_SETTINGS) {
  if (!existsSync(file)) return;
  const s = readSettings(file);
  for (const ev of Object.keys(s.hooks ?? {})) {
    s.hooks[ev] = s.hooks[ev].filter((e: any) => !e?.[TAG]);
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }
  if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
  writeAtomic(file, JSON.stringify(s, null, 2) + "\n");
}

export function hooksState(file = CLAUDE_SETTINGS): "ok" | "missing" | "outdated" {
  const s = readSettings(file);
  let found = 0, current = 0;
  for (const [ev] of EVENTS) {
    const e = (s.hooks?.[ev] ?? []).find((x: any) => x?.[TAG]);
    if (e) { found++; if (e.hooks?.[0]?.command === hookCommand(ev)) current++; }
  }
  return found === 0 ? "missing" : current === EVENTS.length ? "ok" : "outdated";
}

const uid = () => sh(["id", "-u"]).out;

export function installDaemon() {
  const args = [...selfArgv(), "daemon"];
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir() };
  if (process.env.DAYCARE_HOME) env.DAYCARE_HOME = HOME;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${esc(a)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${esc(v)}</string>`).join("")}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(P.daemonLog)}</string>
  <key>StandardErrorPath</key><string>${esc(P.daemonLog)}</string>
</dict></plist>
`;
  mkdirSync(dirname(PLIST), { recursive: true });
  writeFileSync(PLIST, plist);
  sh(["launchctl", "bootout", `gui/${uid()}/${LABEL}`]);
  const r = sh(["launchctl", "bootstrap", `gui/${uid()}`, PLIST]);
  if (!r.ok) throw new Error(`launchctl couldn't start the daemon: ${r.err}`);
}

export function removeDaemon() {
  sh(["launchctl", "bootout", `gui/${uid()}/${LABEL}`]);
  rmSync(PLIST, { force: true });
}

export async function daemonUp(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${config().port}/api/ping`, { signal: AbortSignal.timeout(800) });
    return (await r.text()) === "daycare";
  } catch { return false; }
}

export function installOcr(): string | null {
  if (!sh(["which", "swiftc"]).ok) return "swiftc isn't available (install Xcode Command Line Tools: xcode-select --install).";
  const src = join(P.bin, "ocr.swift");
  writeFileSync(src, ocrSwift);
  const r = sh(["swiftc", "-O", src, "-o", P.ocr], undefined, 180_000);
  return r.ok ? null : `Couldn't build the screenshot reader: ${r.err.slice(0, 300)}`;
}

export function writeDefaultConfig() {
  ensureDirs();
  if (!existsSync(P.config)) writeFileSync(P.config, CONFIG_TEMPLATE);
}
