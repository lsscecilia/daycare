import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Everything Daycare keeps lives under one directory. DAYCARE_HOME moves it (used by tests).
export const HOME = process.env.DAYCARE_HOME || join(homedir(), ".daycare");

export const P = {
  db: join(HOME, "daycare.db"),
  config: join(HOME, "config.yaml"),
  runs: join(HOME, "runs"),
  inbox: join(HOME, "inbox"),
  providers: join(HOME, "providers"),
  templates: join(HOME, "templates"),
  bin: join(HOME, "bin"),
  ocr: join(HOME, "bin", "ocr"),
  token: join(HOME, "ui-token"),
  hookLog: join(HOME, "hook-errors.log"),
  daemonLog: join(HOME, "daemon.log"),
};

export function ensureDirs() {
  for (const d of [HOME, P.runs, P.inbox, P.providers, P.templates, P.bin]) mkdirSync(d, { recursive: true });
}
