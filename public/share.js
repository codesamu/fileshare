import { api, escapeHtml, fmtBytes, fmtDate, fmtDateTime, icon } from './common.js';

const page = document.getElementById('share-page');
const token = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
let siteName = 'a private drive';

function shell(inner, cls = '') {
  page.innerHTML = `<div class="share-card ${cls}">${inner}</div>
    <p class="share-foot muted small">Shared from ${escapeHtml(siteName)}</p>`;
}

function renderError(message, detail = '') {
  shell(
    `<div class="share-error">${icon('lock')}</div>
     <h1>${escapeHtml(message)}</h1>
     <p class="muted">${escapeHtml(detail || 'Ask the person who sent you this link for a new one.')}</p>`
  );
}

function fileKindIcon(kind) {
  return kind === 'image' ? 'image' : kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : kind === 'pdf' ? 'pdf' : 'file';
}

function previewable(file) {
  return ['image', 'video', 'audio', 'pdf', 'text'].includes(file.kind);
}

function renderShare(data) {
  const rows = data.files
    .map(
      (file) => `<div class="share-file">
        <span class="tile tile-${file.kind}">${(file.name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'file')
          .toUpperCase()
          .slice(0, 4)}</span>
        <span class="name-cell">
          <span class="name">${escapeHtml(file.path)}</span>
          <span class="sub">${fmtBytes(file.size)}</span>
        </span>
        <span class="share-file-actions">
          ${
            previewable(file)
              ? `<a class="btn ghost small" href="/api/s/${encodeURIComponent(token)}/file/${file.id}" target="_blank" rel="noopener">View</a>`
              : ''
          }
          <a class="btn primary small" href="/api/s/${encodeURIComponent(token)}/file/${file.id}?dl=1" download>Download</a>
        </span>
      </div>`
    )
    .join('');

  const meta = [
    `${data.files.length} file${data.files.length === 1 ? '' : 's'}`,
    fmtBytes(data.totalSize),
    data.expiresAt ? `link expires ${fmtDate(data.expiresAt)}` : 'no expiry',
  ].join(' · ');

  shell(
    `<div class="share-head">
       <span class="share-badge">${icon('link')} Shared files</span>
       <h1>${escapeHtml(data.name)}</h1>
       <p class="muted">${escapeHtml(meta)}</p>
     </div>
     ${
       data.files.length > 1
         ? `<div class="share-actions">
              <a class="btn primary" href="/api/s/${encodeURIComponent(token)}/zip" download>${icon('download')} Download all as .zip</a>
            </div>`
         : ''
     }
     ${
       data.files.length
         ? `<div class="share-list">${rows}</div>`
         : '<p class="muted">This link has no files in it (the shared folder may be empty).</p>'
     }
     <p class="share-note muted small">Downloads are served straight from the server. Large files resume automatically in most browsers.</p>`
  );
}

function renderLock(data) {
  shell(
    `<div class="share-badge">${icon('lock')} Password required</div>
     <h1>${escapeHtml(data.name)}</h1>
     <p class="muted">${escapeHtml(
       `${data.files.length ? '' : ''}${data.totalSize ? fmtBytes(data.totalSize) : ''}${
         data.expiresAt ? ` · expires ${fmtDate(data.expiresAt)}` : ''
       }`.trim() || 'Enter the password to see these files.'
     )}</p>
     <form id="unlock-form" class="unlock-form">
       <label class="field"><span>Password</span>
         <input type="password" id="unlock-password" autocomplete="current-password" required autofocus></label>
       <button class="btn primary wide" type="submit">Unlock</button>
       <p class="error" id="unlock-error" role="alert"></p>
     </form>`
  );

  const form = document.getElementById('unlock-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = document.getElementById('unlock-error');
    error.textContent = '';
    try {
      await api(`/api/s/${encodeURIComponent(token)}/unlock`, {
        method: 'POST',
        body: { password: document.getElementById('unlock-password').value },
      });
      await load();
    } catch (err) {
      error.textContent = err.message;
    }
  });
}

async function load() {
  if (!token) return renderError('This link is incomplete', 'Check that you copied the whole URL.');
  try {
    const config = await fetch('/api/config').then((r) => r.json()).catch(() => null);
    if (config?.siteName) siteName = config.siteName;
  } catch {
    /* the share itself still works without the site name */
  }
  try {
    const data = await api(`/api/s/${encodeURIComponent(token)}`);
    document.title = `${data.name} · shared`;
    if (data.locked) renderLock(data);
    else renderShare(data);
  } catch (err) {
    if (err.status === 410) return renderError(err.message, 'Links can expire or have a download limit.');
    if (err.status === 404) return renderError('This link does not exist', 'It may have been revoked by the owner.');
    renderError('Could not open this link', err.message);
  }
}

load();
