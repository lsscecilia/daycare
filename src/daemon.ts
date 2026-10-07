// `daycare daemon`: notices dead helpers and ended focus, and serves the room UI on localhost.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { act, type Action } from "./actions";
import { roomHtml } from "./assets";
import { runCommand } from "./command";
import { config } from "./config";
import { P } from "./paths";
import { reconcile } from "./reconcile";
import { addMessage } from "./triage";
import { internalEnv, spawnDetached } from "./util";
import { view } from "./view";

export function uiToken(): string {
  if (existsSync(P.token)) return readFileSync(P.token, "utf8").trim();
  const t = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
  writeFileSync(P.token, t);
  chmodSync(P.token, 0o600);
  return t;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export function serve() {
  const port = config().port;
  const token = uiToken();
  const html = roomHtml.replace("__DAYCARE_TOKEN__", token);
  const tick = () => { try { reconcile(); } catch (e) { console.error(new Date().toISOString(), "reconcile:", e); } };
  tick();
  setInterval(tick, 5000);

  Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      // Only answer requests addressed to localhost (blocks DNS-rebinding tricks), and only
      // answer data requests that carry the token baked into the page (blocks other sites
      // in your browser from reading or driving Daycare).
      const host = req.headers.get("host") ?? "";
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return new Response("wrong host", { status: 403 });
      if (url.pathname === "/api/ping") return new Response("daycare");
      if (url.pathname === "/") return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      const given = req.headers.get("x-daycare-token") ?? url.searchParams.get("token");
      if (given !== token) return json({ error: "bad token" }, 403);

      if (url.pathname === "/api/state") return json(view());

      if (url.pathname === "/api/events") {
        let last = "";
        let iv: Timer, ka: Timer;
        const stream = new ReadableStream({
          start(ctrl) {
            const send = () => {
              try {
                const s = JSON.stringify(view(false));
                if (s !== last) { last = s; ctrl.enqueue(`data: ${s}\n\n`); }
              } catch (e) { console.error("view:", e); }
            };
            send();
            iv = setInterval(send, 1000);
            ka = setInterval(() => { try { ctrl.enqueue(": keepalive\n\n"); } catch {} }, 20_000);
            req.signal.addEventListener("abort", () => { clearInterval(iv); clearInterval(ka); try { ctrl.close(); } catch {} });
          },
          cancel() { clearInterval(iv); clearInterval(ka); },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      }

      if (req.method === "POST" && url.pathname === "/api/action") {
        try { return json({ ok: true, message: act((await req.json()) as Action) }); }
        catch (e) { return json({ ok: false, error: (e as Error).message }, 400); }
      }

      if (req.method === "POST" && url.pathname === "/api/cmd") {
        try {
          const body = (await req.json()) as { text: string; repo?: string };
          const r = await runCommand(String(body.text ?? ""), body.repo ? String(body.repo) : undefined);
          return json(r.ok ? { ok: true, message: r.message } : { ok: false, error: r.message }, r.ok ? 200 : 400);
        } catch (e) { return json({ ok: false, error: (e as Error).message }, 400); }
      }

      if (req.method === "POST" && url.pathname === "/api/drop") {
        try {
          const body = (await req.json()) as { png: string; note?: string };
          const bytes = Buffer.from(String(body.png).replace(/^data:image\/\w+;base64,/, ""), "base64");
          if (bytes.length < 100 || bytes.length > 20_000_000) throw new Error("That doesn't look like a screenshot.");
          const tmp = join(P.inbox, `paste-${Date.now()}.png`);
          writeFileSync(tmp, bytes);
          const id = addMessage(tmp, body.note);
          spawnDetached(["__triage", String(id)], internalEnv());
          return json({ ok: true, message: "Got it. Checking…" });
        } catch (e) { return json({ ok: false, error: (e as Error).message }, 400); }
      }
      return json({ error: "not found" }, 404);
    },
  });
  console.log(`${new Date().toISOString()} daycare daemon on http://127.0.0.1:${port}`);
}
