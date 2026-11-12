import fs from 'node:fs';
import archiver from 'archiver';
import { contentDisposition } from './util.js';

const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

/**
 * Stream a file with HTTP range support. `inline` lets the browser preview
 * images/video/audio and seek in them; `attachment` forces a download.
 */
export async function serveFile(req, res, { filePath, mime, name, mode = 'inline' }) {
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File is missing from storage' }));
    return;
  }

  const total = stat.size;
  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=60',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': contentDisposition(name, mode),
  };

  const match = typeof req.headers.range === 'string' ? RANGE_RE.exec(req.headers.range.trim()) : null;
  if (match) {
    let start;
    let end;
    if (!match[1] && match[2]) {
      const suffix = Number(match[2]);
      start = Math.max(0, total - suffix);
      end = total - 1;
    } else {
      start = Number(match[1] || 0);
      end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    headers['Content-Length'] = String(end - start + 1);
    res.writeHead(206, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return;
  }

  headers['Content-Length'] = String(total);
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/**
 * Zip a set of files and stream it straight to the client. Entries are stored
 * uncompressed: media is already compressed and 15 GB files must not be re-read
 * through zlib on a home server CPU.
 */
export function serveZip(res, entries, zipName) {
  const archive = archiver('zip', { store: true });
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': contentDisposition(zipName, 'attachment'),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  archive.on('warning', (err) => {
    if (err.code !== 'ENOENT') throw err;
  });
  archive.on('error', () => res.destroy());
  res.on('close', () => {
    if (!res.writableEnded) archive.destroy();
  });
  archive.pipe(res);
  for (const entry of entries) archive.file(entry.filePath, { name: entry.name, store: true });
  archive.finalize();
}
