// What a hand-started Claude Code session has cost, estimated from its transcript.
// Claude Code doesn't tell hooks the cost, but every reply in the transcript carries its token
// usage and model. Priced at Anthropic's API rates, so on a subscription it's what the same
// work would cost on the API, not what you're billed.
import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getWorker } from "./items";
import { run, tx } from "./db";

// $ per million tokens: input, output, cache read. Cache writes are 1.25× input (5-minute)
// or 2× input (1-hour). Prices as of 2026-09.
const PRICES: [RegExp, number, number, number][] = [
  [/fable-5-1|mythos-5-1/, 10, 50, 0.25],
  [/fable|mythos/, 10, 50, 1],
  [/opus-5-5/, 4, 20, 0.2],
  [/opus/, 5, 25, 0.5],
  [/sonnet-4/, 3, 15, 0.3],
  [/sonnet/, 2, 10, 0.2],
  [/haiku/, 1, 5, 0.1],
];

export function replyCost(model: string, u: any): number {
  const p = PRICES.find(([re]) => re.test(model));
  if (!p || !u) return 0;
  const [, inp, out, read] = p;
  const fast = u.speed === "fast" ? 2 : 1; // fast mode is 2× the standard rate
  const cc = u.cache_creation ?? {};
  const w1h = cc.ephemeral_1h_input_tokens ?? 0;
  const w5m = cc.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - w1h);
  return fast * ((u.input_tokens ?? 0) * inp + (u.output_tokens ?? 0) * out + (u.cache_read_input_tokens ?? 0) * read + w5m * inp * 1.25 + w1h * inp * 2) / 1e6;
}

const day = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export const today = () => day(Date.now());

// The session's transcript and its sub-agents' transcripts, split by the day each reply came.
export function transcriptCost(path: string): { total: number; byDay: Map<string, number> } {
  const files = [path];
  const sub = join(path.replace(/\.jsonl$/, ""), "subagents");
  if (existsSync(sub)) for (const f of readdirSync(sub)) if (f.endsWith(".jsonl")) files.push(join(sub, f));
  // Claude Code writes one line per content block, each repeating the reply's usage: count each reply once.
  const replies = new Map<string, { model: string; usage: any; at: number }>();
  for (const f of files) {
    let text = "";
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.includes('"usage"')) continue;
      try {
        const j = JSON.parse(line);
        const m = j.message;
        if (m?.usage && m.id && m.model) replies.set(m.id, { model: m.model, usage: m.usage, at: Date.parse(j.timestamp) || Date.now() });
      } catch {}
    }
  }
  const byDay = new Map<string, number>();
  let total = 0;
  for (const r of replies.values()) {
    const c = replyCost(r.model, r.usage);
    total += c;
    byDay.set(day(r.at), (byDay.get(day(r.at)) ?? 0) + c);
  }
  return { total, byDay };
}

// Where Claude Code keeps a session's transcript, if a hook didn't tell us.
export function transcriptFor(cwd: string, sessionId: string): string {
  return join(homedir(), ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
}

// `daycare __cost <worker>`: recounts a session's cost. Launched in the background after each turn.
export function recordCost(id: number) {
  const w = getWorker(id);
  if (!w || w.kind !== "session" || !w.session_id) return;
  const path = w.transcript ?? (w.cwd ? transcriptFor(w.cwd, w.session_id) : null);
  if (!path || !existsSync(path)) return;
  const { total, byDay } = transcriptCost(path);
  tx(() => {
    run("UPDATE worker SET spent = ? WHERE id = ?", total, id);
    run("DELETE FROM spend WHERE worker_id = ?", id);
    for (const [d, usd] of byDay) run("INSERT INTO spend (worker_id, day, usd) VALUES (?,?,?)", id, d, usd);
  });
}
