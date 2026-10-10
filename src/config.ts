import { existsSync, readFileSync } from "fs";
import { P } from "./paths";

export type Config = {
  port: number;
  providers: { messages: string; notes: string; workers: string[] };
  budget_usd: number;
  worktrees: boolean;
  lock_ttl_minutes: number;
  loop_repeat: number;
  notify_session_after_seconds: number;
  repo_folders: string[];
  triage: { allow: string[][]; cwd?: string; p0_words: string[] };
};

export const DEFAULTS: Config = {
  port: 7777,
  providers: { messages: "claude", notes: "claude", workers: ["claude"] },
  budget_usd: 2,
  worktrees: true,
  lock_ttl_minutes: 30,
  loop_repeat: 5,
  notify_session_after_seconds: 120,
  repo_folders: ["~/Repository", "~/Projects", "~/Developer", "~/code", "~/src", "~/dev", "~/work", "~/git", "~/GitHub"],
  triage: {
    allow: [
      ["docker", "ps"], ["docker", "logs"],
      ["kubectl", "get"], ["kubectl", "logs"], ["kubectl", "top"],
      ["gh", "run", "list"], ["gh", "run", "view"], ["gh", "pr", "view"], ["gh", "pr", "checks"],
      ["git", "log"],
    ],
    p0_words: [],
  },
};

export const CONFIG_TEMPLATE = `# Daycare settings. Delete a line to go back to the default.

# Which AI tool does what. Names match files in ~/.daycare/providers/ ("claude" is built in).
providers:
  messages: claude        # reads screenshots and drafts replies
  notes: claude           # recovery notes
  workers: [claude]       # who \`daycare run\` uses; the first one is the default

budget_usd: 2             # spending cap per helper run (Claude Code only)
worktrees: true           # give each task its own git worktree so helpers don't collide
lock_ttl_minutes: 30      # a file lock lapses this long after its holder's last edit
loop_repeat: 5            # identical tool calls in a row before a helper counts as stuck
notify_session_after_seconds: 120   # ping you when a Claude session finishes a turn this long
repo_folders: [~/Repository, ~/Projects, ~/Developer, ~/code]   # where the room's folder picker looks for git repos

triage:
  # Commands Daycare may run to check a message, as argv prefixes. Read-only ones only.
  allow:
    - [docker, ps]
    - [docker, logs]
    - [kubectl, get]
    - [kubectl, logs]
    - [gh, run, view]
    - [gh, pr, view]
  p0_words: []            # extra words that always make a message urgent
`;

function merge(a: any, b: any): any {
  if (b === undefined || b === null) return a;
  if (Array.isArray(a) || Array.isArray(b) || typeof a !== "object" || typeof b !== "object") return b;
  const out: any = { ...a };
  for (const k of Object.keys(b)) out[k] = merge(a[k], b[k]);
  return out;
}

let cached: Config | undefined;
export function config(): Config {
  if (cached) return cached;
  let user = {};
  if (existsSync(P.config)) {
    try { user = (Bun.YAML.parse(readFileSync(P.config, "utf8")) as any) ?? {}; }
    catch (e) { throw new Error(`${P.config} isn't valid YAML: ${(e as Error).message}`); }
  }
  cached = merge(DEFAULTS, user) as Config;
  if (process.env.DAYCARE_PORT) cached.port = Number(process.env.DAYCARE_PORT);
  return cached;
}
