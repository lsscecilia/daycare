// Spike daycared: accept newline-delimited JSON events on a unix socket, count them.
const path = process.argv[2];
let n = 0;
Bun.listen({ unix: path, socket: { data(s, d) { n += d.toString().split("\n").filter(Boolean).length; s.end(); } } });
setInterval(() => Bun.write(path + ".count", String(n)), 200);
