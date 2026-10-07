import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
import { BUILTIN_PROVIDERS } from "./assets";
import { P } from "./paths";

export type Output = { format?: "text" | "json"; result?: string; error?: string; session?: string; cost?: string; reason?: string };
export type Command = { argv: string[]; prompt_via?: "stdin" | "arg" | "file"; output?: Output; timeout_seconds?: number; resume?: string[] };
export type Provider = { name: string; label?: string; ask: Command; work?: Command; governance?: "claude-hooks" | "none" };
export type Parsed = { text: string; isError: boolean; session?: string; cost?: number; reason?: string; parseError?: string };
export type CallResult = Parsed & { code: number | null; stdout: string; stderr: string; ms: number; timedOut: boolean };

const pick = (o: any, path?: string) => (path ? path.split(".").reduce((a, k) => a?.[k], o) : undefined);

export function parseProvider(text: string, source: string): Provider {
  const p = Bun.YAML.parse(text) as Provider;
  if (!p?.name) throw new Error(`${source}: missing "name"`);
  if (!Array.isArray(p.ask?.argv) || !p.ask.argv.length) throw new Error(`${source}: missing "ask.argv"`);
  // A command written as ./something is relative to the provider file, not to wherever it runs.
  const fix = (c?: Command) => {
    if (c?.argv?.[0]?.startsWith("./") && isAbsolute(source)) c.argv[0] = resolve(dirname(source), c.argv[0]);
  };
  fix(p.ask); fix(p.work);
  return p;
}

export function loadProviderFile(file: string): Provider {
  return parseProvider(readFileSync(file, "utf8"), resolve(file));
}

export function loadProvider(name: string): Provider {
  const file = join(P.providers, `${name}.yaml`);
  if (existsSync(file)) return loadProviderFile(file);
  if (BUILTIN_PROVIDERS[name]) return parseProvider(BUILTIN_PROVIDERS[name], `built-in ${name}`);
  throw new Error(`No AI provider called "${name}". Add ~/.daycare/providers/${name}.yaml (see \`daycare provider\`).`);
}

export function listProviders(): string[] {
  const names = new Set(Object.keys(BUILTIN_PROVIDERS));
  if (existsSync(P.providers)) for (const f of readdirSync(P.providers)) if (f.endsWith(".yaml") && !f.startsWith("_")) names.add(f.slice(0, -5));
  return [...names].sort();
}

// Builds the argv for one run. Arguments stay an array and never pass through a shell,
// so a prompt can't inject shell syntax.
export function prepare(cmd: Command, prompt: string, vars: Record<string, string> = {}) {
  const via = cmd.prompt_via ?? "stdin";
  if (via === "arg" && !cmd.argv.some((a) => a.includes("{prompt}"))) throw new Error(`prompt_via is "arg" but argv has no {prompt}`);
  if (via === "file" && !cmd.argv.some((a) => a.includes("{prompt_file}"))) throw new Error(`prompt_via is "file" but argv has no {prompt_file}`);
  const scratch = mkdtempSync(join(tmpdir(), "daycare-prompt-"));
  const promptFile = join(scratch, "prompt.txt");
  if (via === "file") writeFileSync(promptFile, prompt);
  const argv = cmd.argv.map((a) =>
    a.replace(/\{(\w+)\}/g, (m, k) => {
      if (k === "prompt") return prompt;
      if (k === "prompt_file") return promptFile;
      if (k in vars) return vars[k];
      throw new Error(`unknown placeholder ${m} in argv`);
    }),
  );
  return { argv, stdin: via === "stdin" ? prompt : null, cleanup: () => rmSync(scratch, { recursive: true, force: true }) };
}

export function parseOutput(out: Output | undefined, stdout: string, stderr: string, code: number | null): Parsed {
  if ((out?.format ?? "text") !== "json") return { text: stdout.trim(), isError: code !== 0 };
  // Some tools (Claude Code among them) write the JSON result to stderr when the run fails.
  for (const raw of [stdout, stderr]) {
    const s = raw.trim();
    const start = s.indexOf("{");
    if (start < 0) continue;
    try {
      const j = JSON.parse(s.slice(start));
      const cost = Number(pick(j, out!.cost));
      return {
        text: String(pick(j, out!.result) ?? ""),
        isError: code !== 0 || !!pick(j, out!.error),
        session: pick(j, out!.session),
        cost: Number.isFinite(cost) ? cost : undefined,
        reason: pick(j, out!.reason),
      };
    } catch {}
  }
  return { text: "", isError: true, parseError: "output was not JSON" };
}

// Runs a command to completion. stdin is closed unless the prompt goes there, so a tool
// that waits for interactive input times out instead of hanging Daycare.
export async function call(cmd: Command, prompt: string, cwd: string, vars: Record<string, string> = {}, env?: Record<string, string>): Promise<CallResult> {
  const { argv, stdin, cleanup } = prepare(cmd, prompt, vars);
  const t0 = performance.now();
  let timedOut = false;
  try {
    const proc = Bun.spawn(argv, { cwd, env, stdin: stdin !== null ? new Blob([stdin]) : "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => { timedOut = true; proc.kill("SIGTERM"); setTimeout(() => proc.kill("SIGKILL"), 5000); }, (cmd.timeout_seconds ?? 120) * 1000);
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    clearTimeout(timer);
    const parsed = parseOutput(cmd.output, stdout, stderr, code);
    return { ...parsed, isError: parsed.isError || timedOut, code, stdout, stderr, ms: Math.round(performance.now() - t0), timedOut };
  } catch (e) {
    return { text: "", isError: true, parseError: (e as Error).message, code: null, stdout: "", stderr: String(e), ms: Math.round(performance.now() - t0), timedOut };
  } finally {
    cleanup();
  }
}
