import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { BUILTIN_TEMPLATES } from "./assets";
import { P } from "./paths";

export type TemplateStep = {
  name: string; owner: "me" | "agent"; prompt?: string; checklist?: string[];
  provider?: string; budget_usd?: number; max_minutes?: number;
};
export type Template = { name: string; steps: TemplateStep[] };

function parse(text: string, source: string): Template {
  const t = Bun.YAML.parse(text) as Template;
  if (!t?.name || !Array.isArray(t.steps) || !t.steps.length) throw new Error(`${source}: a template needs a name and at least one step`);
  for (const s of t.steps) {
    if (!s.name || (s.owner !== "me" && s.owner !== "agent")) throw new Error(`${source}: every step needs a name and owner (me or agent)`);
    if (s.owner === "agent" && !s.prompt) throw new Error(`${source}: agent step "${s.name}" needs a prompt`);
  }
  return t;
}

export function loadTemplate(name: string): Template {
  const file = join(P.templates, `${name}.yaml`);
  if (existsSync(file)) return parse(readFileSync(file, "utf8"), file);
  if (BUILTIN_TEMPLATES[name]) return parse(BUILTIN_TEMPLATES[name], `built-in ${name}`);
  throw new Error(`No template called "${name}". Templates: ${listTemplates().join(", ")}`);
}

export function listTemplates(): string[] {
  const names = new Set(Object.keys(BUILTIN_TEMPLATES));
  if (existsSync(P.templates)) for (const f of readdirSync(P.templates)) if (f.endsWith(".yaml")) names.add(f.slice(0, -5));
  return [...names].sort();
}

export function render(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);
}
