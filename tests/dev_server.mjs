// Lokal server til udvikling: serverer src/ og kører de rigtige handlers i api/ uden Vercel-konto.
// Kørsel: node tests/dev_server.mjs [port]   (standard 8788)
// Variabler læses fra .env i projektroden (eller fra miljøet): RACKBEAT_API_KEY,
// RACKBEAT_BASE_URL (peg på mocken: node tests/mock_rackbeat.js) og SALGSTEMPO_MAX_SIDER.
// Serveren lytter kun på 127.0.0.1 og har ingen login. Brug den kun lokalt.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 8788);

// .env: NAVN=værdi. Miljøet går forud. Værdier skrives aldrig til skærmen.
try {
  for (const linje of fs.readFileSync(path.join(ROD, '.env'), 'utf-8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(linje);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = /^(["']).*\1$/.test(m[2]) ? m[2].slice(1, -1) : m[2];
  }
} catch { /* ingen .env */ }

const TYPER = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
const RUTER = { '/api/status': '../api/status.mjs', '/api/salgstempo': '../api/salgstempo.mjs' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    const fil = RUTER[url.pathname];
    const rute = fil && await import(pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), fil)).href);
    const handler = rute && rute[req.method];
    if (!handler) { res.writeHead(fil ? 405 : 404); return res.end(); }
    const svar = await handler(new Request(url, { method: req.method }));
    res.writeHead(svar.status, Object.fromEntries(svar.headers));
    return res.end(Buffer.from(await svar.arrayBuffer()));
  }
  const fil = path.join(ROD, 'src', path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!fil.startsWith(path.join(ROD, 'src') + path.sep) || !fs.existsSync(fil) || fs.statSync(fil).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPER[path.extname(fil)] || 'application/octet-stream' });
  fs.createReadStream(fil).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`Lokal server: http://127.0.0.1:${PORT}/v2/produktionskalender-v2.html`));
