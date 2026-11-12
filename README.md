# Home Drive

A self-hosted file drive for a home server: upload from the browser, copy big files in over
Samba, preview and download them from anywhere through your Cloudflare Tunnel, and hand friends
a link that just works — no account needed.

- **Chunked, resumable uploads** — 8 MB chunks, so a 15 GB file survives a dropped connection,
  a browser refresh, or a proxy body limit. Files are written directly at their final offset on
  disk; finishing an upload is a rename, not a copy.
- **Samba ingest** — copy a 15 GB folder over SMB at line speed into `data/ingest`, then press
  *Import*. On the same filesystem files are moved, not copied, so they appear instantly.
- **Preview in the browser** — images, video and audio (with seeking), PDFs and text/code.
- **Share links** — public, optional password, expiry and download limit, revocable at any time.
  Folder shares list their contents and offer a single `.zip` download.
- **Streaming downloads** with HTTP range support, so a friend can resume a large download.
- **No database server, no build step** — Node 22+, SQLite via `node:sqlite`, one npm dependency.

## Quick start (Docker, recommended on Proxmox)

Put the files somewhere on the host, e.g. `/opt/home-drive`:

```bash
cp .env.example .env
nano .env            # set ADMIN_PASSWORD (and SITE_NAME if you like)
echo "DRIVE_PATH=/mnt/data/drive" >> .env
mkdir -p /mnt/data/drive
docker compose up -d --build
docker compose logs -f      # shows the URL and any generated password
```

Open `http://<server-ip>:8080` and sign in with `ADMIN_PASSWORD`.

`DRIVE_PATH` is the host directory that holds everything: `drive.db`, `blobs/` (the files) and
`ingest/` (the Samba drop folder). Point it at your big disk.

## Without Docker (systemd)

```bash
sudo useradd -r -m -d /opt/home-drive drive
sudo cp -r . /opt/home-drive && cd /opt/home-drive
sudo -u drive npm ci --omit=dev
sudo -u drive cp .env.example .env && sudo -u drive nano .env

sudo cp deploy/home-drive.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now home-drive
journalctl -u home-drive -f
```

## Getting 15 GB in fast

Browser uploads over the tunnel are limited by your **upload bandwidth**, not by this app. For
bulk files, put them in the drop folder over the LAN instead.

The drop folder is `$DRIVE_PATH/ingest` on the host (`DRIVE_PATH` from `.env`, e.g.
`/mnt/data/drive`). It must be a **bind mount** — `docker-compose.yml` already does
`${DRIVE_PATH}:/data` — because a named Docker volume would be invisible to Finder and `scp`.

### Option A — Finder (most convenient)

1. On the Ubuntu host, share the drop folder (`/etc/samba/smb.conf`):

   ```ini
   [drive-ingest]
      path = /mnt/data/drive/ingest
      browseable = yes
      read only = no
      valid users = youruser
      force user = youruser
      create mask = 0664
      directory mask = 0775
   ```

   ```bash
   sudo apt install samba
   sudo systemctl restart smbd
   sudo smbpasswd -a youruser
   ```

2. In Finder: **Go → Connect to Server…** (⌘K) → `smb://server.lan/drive-ingest` → sign in with
   that Samba user and tick *Remember this password* (Keychain handles it from then on). Drag
   files or folders straight in. To keep it around, drag the mounted volume into the Finder
   sidebar under **Favourites**.

   Finder can't speak SFTP, so SMB is the native route on a Mac. If you'd rather not install
   Samba on the host, run a small Samba container in `docker-compose.yml` mounting the same
   volume — the drive doesn't care who writes the files.

Finder's SMB copy is fine for a handful of big files, but slow for thousands of small ones.

### Option B — rsync or scp from the Mac Terminal

No Samba needed, and better for many small files or flaky Wi-Fi:

```bash
# resumable: re-run the same command and it continues where it stopped
rsync -avh --progress --partial --inplace ~/Movies/2019-trip/ you@server.lan:/mnt/data/drive/ingest/

# or plain scp
scp -r ~/Movies/2019-trip you@server.lan:/mnt/data/drive/ingest/
```

### Then import

In the web app open **Import from Samba** → **Import selected**. The files are moved into the
library, not copied: same disk, so a 15 GB file appears in milliseconds. Nothing is published
automatically — that's deliberate, so a half-finished copy never ends up in a share link.

Imported files land in the root of the drive; rename, move on, or share them from there.

> Permissions: the container runs as root, so it can import files you copied as your own user. If
> you also want to tidy blobs over SSH, either `sudo chown -R youruser /mnt/data/drive/blobs`
> once, or uncomment `user: "1000:1000"` in `docker-compose.yml` and chown `DRIVE_PATH` to match.

> If the drop folder and the blobs are on different filesystems, the import falls back to a
> copy — still no upload, just a disk-to-disk copy.

## Cloudflare Tunnel

Your existing tunnel just needs to point at the app:

```yaml
# /etc/cloudflared/config.yml
tunnel: <tunnel-id>
credentials-file: /root/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: drive.example.com
    service: http://localhost:8080
  - service: http_status:404
```

```bash
cloudflared tunnel route dns <tunnel-id> drive.example.com
sudo systemctl restart cloudflared
```

Details that matter for large files:

- Cloudflare's free plan caps a **single request body at 100 MB**. The app uploads in 8 MB
  chunks, so browser uploads of 15 GB files pass fine — they are just limited by your upstream
  speed. Don't raise `CHUNK_SIZE_MB` above 90.
- Downloads stream through the tunnel; resuming works because range requests are supported.
- Use `localhost` (not a public IP) in the `service:` line — the app trusts
  `X-Forwarded-Proto`/`X-Forwarded-Host` from the tunnel when building share URLs.
- If you want the admin UI to be private while links stay public, put **Cloudflare Access** in
  front of `drive.example.com` and add a bypass policy for `/s/*`.

## Share links

Open a file or folder → link button → choose password / expiry / download limit → the URL is
copied. Manage and revoke links under **Shared links**. Every download increments a counter, and
an expired or over-limit link returns a plain "this link has expired" page.

The token is 22 URL-safe characters from `crypto.randomBytes(16)`, so links are not guessable.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port |
| `ADMIN_PASSWORD` | generated | The only password. Changing it signs out all sessions |
| `SITE_NAME` | `Home Drive` | Shown in the UI |
| `SESSION_SECRET` | generated | Cookie signing key; stored in the DB if unset |
| `DATA_DIR` | `./data` | Database, blobs and drop folder |
| `INGEST_DIR` | `DATA_DIR/ingest` | Samba drop folder, if you want it elsewhere |
| `MAX_UPLOAD_GB` | `200` | Largest single file |
| `CHUNK_SIZE_MB` | `8` | Upload chunk size |
| `SESSION_DAYS` | `30` | Session lifetime |

## Backups

Stop the container (or use `sqlite3 drive.db ".backup ..."` for the database) and copy the whole
`DRIVE_PATH`. File contents live in `blobs/xx/<uuid>` — keep `drive.db` with them, since names
and folders are stored there.

## Limitations worth knowing

- One admin account, no per-user permissions. Share links are the way to give others access.
- No versioning, no trash: deleting a file removes the blob immediately.
- No thumbnails or server-side transcoding. Video plays in whatever the browser supports
  (H.264/WebM); MKV may download instead of playing.
- Uploads are stored on the local filesystem, not S3 — that is the point, but it means no
  multi-node setup.

## Development

```bash
npm install
ADMIN_PASSWORD=dev npm run dev     # http://localhost:8080
npm run check                      # syntax check of server and client
```

`data/` is created on first run and ignored by git.
