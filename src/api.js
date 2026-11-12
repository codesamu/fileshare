import fsp from 'node:fs/promises';
import path from 'node:path';
import { BLOBS_DIR, CHUNK_SIZE, INGEST_DIR, MAX_UPLOAD_BYTES, SITE_NAME } from './config.js';
import { getDb } from './db.js';
import {
  checkPassword,
  clearLoginAttempts,
  clearSessionCookie,
  hasShareCookie,
  isAuthed,
  setSessionCookie,
  setShareCookie,
  scryptHash,
  scryptVerify,
  throttleLogin,
} from './auth.js';
import { kindFor, randomToken, contentDisposition } from './util.js';
import { createUpload, writeChunk, completeUpload, cancelUpload, getUpload } from './uploads.js';
import { importPaths, listIngest } from './ingest.js';
import { serveFile, serveZip } from './stream.js';

function json(res, status, data) {
  if (res.headersSent) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function httpError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  err.extra = extra;
  return err;
}

async function readJson(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Invalid JSON body');
  }
}

/* ---------- shaping ---------- */

function fileJson(row) {
  return {
    id: row.id,
    name: row.name,
    size: row.size,
    mime: row.mime,
    kind: kindFor(row.name, row.mime),
    folderId: row.folder_id || null,
    createdAt: row.created_at,
    downloaded: row.downloaded || 0,
  };
}

function folderJson(row, counts) {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id || null,
    createdAt: row.created_at,
    fileCount: counts?.files || 0,
    size: counts?.size || 0,
  };
}

function blobPath(rel) {
  return path.join(BLOBS_DIR, rel);
}

function cleanName(input, fallback = 'Untitled') {
  const name = String(input || '')
    .replace(/[\r\n/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return name || fallback;
}

function getFolder(id) {
  if (!id || id === 'root') return null;
  return getDb().prepare('SELECT * FROM folders WHERE id = ?').get(id) || null;
}

function getFile(id) {
  return getDb().prepare('SELECT * FROM files WHERE id = ?').get(id) || null;
}

function descendants(folderId) {
  return getDb()
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM folders WHERE id = ?
         UNION ALL SELECT f.id FROM folders f JOIN sub s ON f.parent_id = s.id
       ) SELECT id FROM sub`
    )
    .all(folderId)
    .map((r) => r.id);
}

function filesUnderFolder(folderId) {
  const ids = descendants(folderId);
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return getDb().prepare(`SELECT * FROM files WHERE folder_id IN (${placeholders})`).all(...ids);
}

/* ---------- shares ---------- */

function shareItems(shareId) {
  return getDb().prepare('SELECT item_id, kind FROM share_items WHERE share_id = ?').all(shareId);
}

function collectShareFiles(shareId) {
  const out = [];
  for (const item of shareItems(shareId)) {
    if (item.kind === 'file') {
      const file = getFile(item.item_id);
      if (file) out.push({ file, name: file.name });
      continue;
    }
    const folder = getFolder(item.item_id);
    if (!folder) continue;
    const walk = (fid, prefix) => {
      const files = getDb().prepare('SELECT * FROM files WHERE folder_id = ? ORDER BY name COLLATE NOCASE').all(fid);
      for (const file of files) out.push({ file, name: `${prefix}${file.name}` });
      const subs = getDb().prepare('SELECT * FROM folders WHERE parent_id = ? ORDER BY name COLLATE NOCASE').all(fid);
      for (const sub of subs) walk(sub.id, `${prefix}${sub.name}/`);
    };
    walk(folder.id, `${folder.name}/`);
  }
  return out;
}

function getShare(token) {
  return getDb().prepare('SELECT * FROM shares WHERE token = ?').get(token) || null;
}

function shareBlocked(share) {
  if (share.expires_at && Date.now() > share.expires_at) return 'This link has expired.';
  if (share.max_downloads && share.downloads >= share.max_downloads) return 'This link reached its download limit.';
  return null;
}

function shareMeta(share) {
  const items = shareItems(share.id);
  const first = items[0];
  let kind = first?.kind || 'file';
  let itemName = 'Shared files';
  if (first?.kind === 'file') itemName = getFile(first.item_id)?.name || itemName;
  if (first?.kind === 'folder') itemName = getFolder(first.item_id)?.name || itemName;
  return { kind, itemName, itemCount: items.length };
}

function shareJson(share, origin) {
  const meta = shareMeta(share);
  const files = collectShareFiles(share.id);
  return {
    id: share.id,
    token: share.token,
    url: `${origin}/s/${share.token}`,
    name: share.name,
    kind: meta.kind,
    itemName: meta.itemName,
    fileCount: files.length,
    totalSize: files.reduce((sum, f) => sum + f.file.size, 0),
    hasPassword: !!share.password_hash,
    expiresAt: share.expires_at,
    maxDownloads: share.max_downloads,
    downloads: share.downloads,
    createdAt: share.created_at,
    blocked: shareBlocked(share),
  };
}

function originFor(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${process.env.PORT || 8080}`;
  return `${String(proto).split(',')[0]}://${String(host).split(',')[0]}`;
}

/* ---------- handlers ---------- */

const routes = [];
function route(method, pattern, handler, opts = {}) {
  routes.push({ method, pattern: pattern.split('/').filter(Boolean), handler, public: !!opts.public });
}

route('GET', '/api/config', async (req, res) => {
  json(res, 200, {
    siteName: SITE_NAME,
    chunkSize: CHUNK_SIZE,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    authenticated: isAuthed(req),
    ingestDir: INGEST_DIR,
  });
}, { public: true });

route('GET', '/api/session', async (req, res) => {
  json(res, 200, { authenticated: isAuthed(req) });
}, { public: true });

route('POST', '/api/login', async (req, res) => {
  const gate = throttleLogin(req);
  if (!gate.ok) throw httpError(429, `Too many attempts. Try again in ${gate.retryAfter}s.`);
  const body = await readJson(req);
  if (!checkPassword(body.password || '')) throw httpError(401, 'Wrong password');
  clearLoginAttempts(req);
  setSessionCookie(res);
  json(res, 200, { ok: true });
}, { public: true });

route('POST', '/api/logout', async (req, res) => {
  clearSessionCookie(res);
  json(res, 200, { ok: true });
}, { public: true });

route('GET', '/api/browse', async (req, res, url) => {
  const db = getDb();
  const folderId = url.searchParams.get('folder');
  const folder = folderId && folderId !== 'root' ? getFolder(folderId) : null;
  if (folderId && folderId !== 'root' && !folder) throw httpError(404, 'Folder not found');

  const parent = folder ? folder.id : null;
  const folders = db
    .prepare('SELECT * FROM folders WHERE parent_id IS ? ORDER BY name COLLATE NOCASE')
    .all(parent);
  const files = db
    .prepare('SELECT * FROM files WHERE folder_id IS ? ORDER BY name COLLATE NOCASE')
    .all(parent);

  const counts = new Map(
    db
      .prepare('SELECT folder_id, COUNT(*) AS files, SUM(size) AS size FROM files WHERE folder_id IS NOT NULL GROUP BY folder_id')
      .all()
      .map((row) => [row.folder_id, { files: row.files, size: row.size || 0 }])
  );

  const crumbs = [];
  let cursor = folder;
  while (cursor) {
    crumbs.unshift({ id: cursor.id, name: cursor.name });
    cursor = cursor.parent_id ? getFolder(cursor.parent_id) : null;
  }

  const totals = db.prepare('SELECT COUNT(*) AS files, SUM(size) AS size FROM files').get();

  json(res, 200, {
    folder: folder ? { id: folder.id, name: folder.name, parentId: folder.parent_id || null } : null,
    breadcrumb: crumbs,
    folders: folders.map((row) => folderJson(row, counts.get(row.id))),
    files: files.map(fileJson),
    totals: { files: totals.files || 0, size: totals.size || 0 },
  });
});

route('POST', '/api/folders', async (req, res) => {
  const body = await readJson(req);
  const parentId = body.parentId && body.parentId !== 'root' ? body.parentId : null;
  if (parentId && !getFolder(parentId)) throw httpError(404, 'Parent folder not found');
  const id = randomToken(8);
  getDb()
    .prepare('INSERT INTO folders (id, name, parent_id, created_at) VALUES (?, ?, ?, ?)')
    .run(id, cleanName(body.name, 'New folder'), parentId, Date.now());
  json(res, 201, { id, name: cleanName(body.name, 'New folder'), parentId });
});

route('PATCH', '/api/items/:id', async (req, res, _url, params) => {
  const body = await readJson(req);
  const name = cleanName(body.name);
  const kind = body.kind === 'folder' ? 'folder' : 'file';
  if (kind === 'folder') {
    const folder = getFolder(params.id);
    if (!folder) throw httpError(404, 'Folder not found');
    getDb().prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, folder.id);
  } else {
    const file = getFile(params.id);
    if (!file) throw httpError(404, 'File not found');
    getDb().prepare('UPDATE files SET name = ? WHERE id = ?').run(name, file.id);
  }
  json(res, 200, { ok: true, name });
});

route('DELETE', '/api/items/:id', async (req, res, url, params) => {
  const kind = url.searchParams.get('kind') === 'folder' ? 'folder' : 'file';
  if (kind === 'folder') {
    const folder = getFolder(params.id);
    if (!folder) throw httpError(404, 'Folder not found');
    const files = filesUnderFolder(folder.id);
    for (const file of files) await fsp.rm(blobPath(file.blob), { force: true });
    const ids = descendants(folder.id);
    const placeholders = ids.map(() => '?').join(',');
    getDb().prepare(`DELETE FROM files WHERE folder_id IN (${placeholders})`).run(...ids);
    getDb().prepare(`DELETE FROM folders WHERE id IN (${placeholders})`).run(...ids);
    getDb()
      .prepare(`DELETE FROM share_items WHERE item_id IN (${placeholders})`)
      .run(...ids);
    json(res, 200, { ok: true, deletedFiles: files.length });
    return;
  }
  const file = getFile(params.id);
  if (!file) throw httpError(404, 'File not found');
  await fsp.rm(blobPath(file.blob), { force: true });
  getDb().prepare('DELETE FROM files WHERE id = ?').run(file.id);
  getDb().prepare('DELETE FROM share_items WHERE item_id = ?').run(file.id);
  json(res, 200, { ok: true });
});

route('GET', '/api/files/:id/stream', async (req, res, url, params) => {
  const file = getFile(params.id);
  if (!file) throw httpError(404, 'File not found');
  await serveFile(req, res, {
    filePath: blobPath(file.blob),
    mime: file.mime,
    name: file.name,
    mode: url.searchParams.get('dl') ? 'attachment' : 'inline',
  });
});

route('GET', '/api/files/:id/text', async (req, res, _url, params) => {
  const file = getFile(params.id);
  if (!file) throw httpError(404, 'File not found');
  const limit = 400 * 1024;
  const handle = await fsp.open(blobPath(file.blob), 'r').catch(() => null);
  if (!handle) throw httpError(404, 'File is missing from storage');
  try {
    const buffer = Buffer.alloc(Math.min(limit, file.size));
    await handle.read(buffer, 0, buffer.length, 0);
    json(res, 200, { text: buffer.toString('utf8'), truncated: file.size > limit });
  } finally {
    await handle.close();
  }
});

route('POST', '/api/uploads', async (req, res) => {
  const body = await readJson(req);
  if (body.folderId && body.folderId !== 'root' && !getFolder(body.folderId)) {
    throw httpError(404, 'Target folder not found');
  }
  const upload = await createUpload({
    name: body.name,
    size: body.size,
    folderId: body.folderId && body.folderId !== 'root' ? body.folderId : null,
    resumeId: body.resumeId,
  });
  json(res, 201, upload);
});

route('PUT', '/api/uploads/:id/:index', async (req, res, _url, params) => {
  const result = await writeChunk(params.id, params.index, req);
  json(res, 200, result);
});

route('GET', '/api/uploads/:id', async (req, res, _url, params) => {
  const upload = getUpload(params.id);
  if (!upload) throw httpError(404, 'Upload not found');
  json(res, 200, {
    uploadId: upload.id,
    name: upload.name,
    size: upload.size,
    chunkSize: upload.chunkSize,
    chunks: upload.chunks,
    received: [...upload.received].sort((a, b) => a - b),
  });
});

route('POST', '/api/uploads/:id/complete', async (req, res, _url, params) => {
  const file = await completeUpload(params.id);
  json(res, 201, file);
});

route('DELETE', '/api/uploads/:id', async (req, res, _url, params) => {
  await cancelUpload(params.id);
  json(res, 200, { ok: true });
});

route('GET', '/api/shares', async (req, res) => {
  const rows = getDb().prepare('SELECT * FROM shares ORDER BY created_at DESC').all();
  const origin = originFor(req);
  json(res, 200, { shares: rows.map((row) => shareJson(row, origin)) });
});

route('POST', '/api/shares', async (req, res) => {
  const body = await readJson(req);
  const kind = body.kind === 'folder' ? 'folder' : 'file';
  const itemId = String(body.itemId || '');
  const item = kind === 'folder' ? getFolder(itemId) : getFile(itemId);
  if (!item) throw httpError(404, 'Item not found');

  const shareId = randomToken(10);
  const token = randomToken(16);
  const days = Number(body.expiresInDays) || 0;
  const maxDownloads = Number(body.maxDownloads) || 0;
  const password = String(body.password || '').trim().slice(0, 100);
  const name = cleanName(body.name, kind === 'folder' ? item.name : item.name);

  getDb()
    .prepare(
      'INSERT INTO shares (id, token, name, password_hash, expires_at, max_downloads, downloads, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)'
    )
    .run(
      shareId,
      token,
      name,
      password ? scryptHash(password) : null,
      days > 0 ? Date.now() + days * 86400_000 : null,
      maxDownloads > 0 ? maxDownloads : null,
      Date.now()
    );
  getDb()
    .prepare('INSERT INTO share_items (share_id, item_id, kind) VALUES (?, ?, ?)')
    .run(shareId, itemId, kind);

  const share = getDb().prepare('SELECT * FROM shares WHERE id = ?').get(shareId);
  json(res, 201, shareJson(share, originFor(req)));
});

route('DELETE', '/api/shares/:id', async (req, res, _url, params) => {
  getDb().prepare('DELETE FROM shares WHERE id = ?').run(params.id);
  getDb().prepare('DELETE FROM share_items WHERE share_id = ?').run(params.id);
  json(res, 200, { ok: true });
});

route('GET', '/api/ingest', async (req, res) => {
  const files = await listIngest();
  json(res, 200, { dir: INGEST_DIR, files });
});

route('POST', '/api/ingest/import', async (req, res) => {
  const body = await readJson(req);
  const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
  if (!paths.length) throw httpError(400, 'No files selected');
  const result = await importPaths(paths);
  json(res, 200, result);
});

/* ---------- public share routes ---------- */

function publicShare(token, req) {
  const share = getShare(token);
  if (!share) throw httpError(404, 'This link does not exist.');
  const blocked = shareBlocked(share);
  if (blocked) throw httpError(410, blocked);
  if (share.password_hash && !hasShareCookie(req, token)) {
    return { share, locked: true };
  }
  return { share, locked: false };
}

route('GET', '/api/s/:token', async (req, res, _url, params) => {
  const { share, locked } = publicShare(params.token, req);
  const files = locked ? [] : collectShareFiles(share.id);
  json(res, 200, {
    name: share.name,
    locked,
    hasPassword: !!share.password_hash,
    createdAt: share.created_at,
    expiresAt: share.expires_at,
    maxDownloads: share.max_downloads,
    downloads: share.downloads,
    totalSize: files.reduce((sum, f) => sum + f.file.size, 0),
    files: files.map(({ file, name }) => ({ ...fileJson(file), path: name })),
  });
}, { public: true });

route('POST', '/api/s/:token/unlock', async (req, res, _url, params) => {
  const share = getShare(params.token);
  if (!share) throw httpError(404, 'This link does not exist.');
  const blocked = shareBlocked(share);
  if (blocked) throw httpError(410, blocked);
  const body = await readJson(req);
  if (!share.password_hash) {
    json(res, 200, { ok: true });
    return;
  }
  const gate = throttleLogin(req);
  if (!gate.ok) throw httpError(429, `Too many attempts. Try again in ${gate.retryAfter}s.`);
  if (!scryptVerify(body.password || '', share.password_hash)) throw httpError(401, 'Wrong password');
  clearLoginAttempts(req);
  setShareCookie(res, share.token);
  json(res, 200, { ok: true });
}, { public: true });

route('GET', '/api/s/:token/file/:fileId', async (req, res, url, params) => {
  const access = publicShare(params.token, req);
  if (access.locked) throw httpError(401, 'This link is password protected.');
  const entry = collectShareFiles(access.share.id).find((e) => e.file.id === params.fileId);
  if (!entry) throw httpError(404, 'File not found in this share');
  if (url.searchParams.get('dl')) {
    getDb().prepare('UPDATE shares SET downloads = downloads + 1 WHERE id = ?').run(access.share.id);
  }
  await serveFile(req, res, {
    filePath: blobPath(entry.file.blob),
    mime: entry.file.mime,
    name: entry.file.name,
    mode: url.searchParams.get('dl') ? 'attachment' : 'inline',
  });
}, { public: true });

route('GET', '/api/s/:token/zip', async (req, res, _url, params) => {
  const access = publicShare(params.token, req);
  if (access.locked) throw httpError(401, 'This link is password protected.');
  const entries = collectShareFiles(access.share.id);
  if (!entries.length) throw httpError(404, 'This share has no files');
  getDb().prepare('UPDATE shares SET downloads = downloads + 1 WHERE id = ?').run(access.share.id);
  const zipName = `${entries.length === 1 ? entries[0].file.name.replace(/\.[^.]+$/, '') : access.share.name}.zip`;
  serveZip(
    res,
    entries.map((e) => ({ filePath: blobPath(e.file.blob), name: e.name })),
    zipName
  );
}, { public: true });

/* ---------- dispatcher ---------- */

function matchRoute(pattern, segments) {
  if (pattern.length !== segments.length) return null;
  const params = {};
  for (let i = 0; i < pattern.length; i++) {
    const part = pattern[i];
    if (part.startsWith(':')) {
      try {
        params[part.slice(1)] = decodeURIComponent(segments[i]);
      } catch {
        return null;
      }
    } else if (part !== segments[i]) {
      return null;
    }
  }
  return params;
}

export async function handleApi(req, res, url) {
  const segments = url.pathname.split('/').filter(Boolean);
  let matchedPath = false;

  for (const entry of routes) {
    const params = matchRoute(entry.pattern, segments);
    if (!params) continue;
    matchedPath = true;
    if (entry.method !== req.method && !(entry.method === 'GET' && req.method === 'HEAD')) continue;

    if (!entry.public && !isAuthed(req)) {
      json(res, 401, { error: 'Not signed in' });
      return;
    }

    try {
      await entry.handler(req, res, url, params);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(`[api] ${req.method} ${url.pathname}:`, err);
      if (!res.headersSent) json(res, status, { error: err.message || 'Server error', ...(err.extra || {}) });
      else res.destroy();
    }
    return;
  }

  json(res, matchedPath ? 405 : 404, { error: matchedPath ? 'Method not allowed' : 'Not found' });
}

export { json, readJson, httpError, contentDisposition };
