// Spike hook client: read stdin, send to daycared, spool on failure, always exit 0.
import { appendFileSync } from "fs";
const sock = process.env.DAYCARE_SOCK!;
const payload = (await Bun.stdin.text()).replace(/\n/g, " ");
const line = JSON.stringify({ ev: process.argv[2], payload }) + "\n";
try {
  await new Promise<void>((resolve, reject) => {
    Bun.connect({ unix: sock, socket: {
      open(s) { s.write(line); s.end(); }, data() {},
      close() { resolve(); }, error(_s, e) { reject(e); },
      connectError(_s, e) { reject(e); },
    } }).catch(reject);
    setTimeout(() => reject(new Error("timeout")), 500);
  });
} catch (e) { if (process.env.Q5_DEBUG) console.error(e); appendFileSync(sock + ".spool", line); }
process.exit(0);
