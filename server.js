import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './src/api.js';
import { initDb } from './src/db.js';
import { initAuth } from './src/auth.js';
import { initUploads } from './src/uploads.js';
import { DATA_DIR, BLOBS_DIR, INGEST_DIR, HOST, PORT, SITE_NAME } from './src/config.js';
import { resolveInside } from './src/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'"
  );
}

async function serveStatic(res, filePath) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': STATIC_MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    // Always revalidate: a stale app.js after an update is worse than a few extra KB.
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);

  let url;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }

    // Public share pages get their own small app.
    if (url.pathname === '/s' || url.pathname.startsWith('/s/')) {
      if (await serveStatic(res, path.join(PUBLIC_DIR, 'share.html'))) return;
    }

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const filePath = resolveInside(PUBLIC_DIR, rel);
    if (filePath && (await serveStatic(res, filePath))) return;

    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Server error');
    else res.destroy();
  }
});

server.requestTimeout = 0; // large streamed uploads/downloads must not be cut off
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(BLOBS_DIR, { recursive: true });
  fs.mkdirSync(INGEST_DIR, { recursive: true });
  initDb();
  initAuth();
  await initUploads();

  server.listen(PORT, HOST, () => {
    console.log(`\n  ${SITE_NAME} is running`);
    console.log(`  → http://localhost:${PORT}`);
    console.log(`  data:   ${DATA_DIR}`);
    console.log(`  ingest: ${INGEST_DIR}  (drop files here over Samba, then import in the UI)\n`);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n  ${signal} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
