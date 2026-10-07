#!/usr/bin/env bun
// Checks that an AI provider config works with Daycare. Same as `daycare provider test <file>`.
// Usage: bun tools/daycare-probe.ts <provider.yaml> [--work]
//   --work also runs the worker check, which lets the tool create a file in a throwaway git repo.
import { printProbe, probe } from "../src/probe";
import { loadProviderFile } from "../src/provider";

const file = process.argv[2];
if (!file) { console.error("usage: bun tools/daycare-probe.ts <provider.yaml> [--work]"); process.exit(2); }
const p = loadProviderFile(file);
const res = await probe(p, { work: process.argv.includes("--work") });
printProbe(p.label ?? p.name, res);
process.exit(res.checks.some((c) => c.ok === false) ? 1 : 0);
