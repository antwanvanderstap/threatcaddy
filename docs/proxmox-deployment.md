# Deploying ThreatCaddy to Proxmox

Full self-hosted stack — client, API and database behind one Caddy instance
that terminates TLS — on a Docker host running in a Proxmox VM.

For the general deployment reference (environment variables, hardening,
monitoring, upgrades) see [deployment.md](deployment.md). This document covers
only what is specific to running it on Proxmox.

---

## 1. What actually moves

ThreatCaddy is client-side by design, and that shapes the whole exercise:

| Piece | Moves to Proxmox? |
|---|---|
| Team server (Hono) + PostgreSQL | Yes — this is the containerised part |
| Built SPA (static files) | Yes — served by Caddy in the same stack |
| **Your investigation data** | **No.** It lives in IndexedDB in your browser |
| Browser extension | No — it runs in the browser, by definition |

The last two are the ones that surprise people. Deploying the stack gives you
a *server*; it does not relocate the notes, IOCs, timelines and assets already
sitting in your Mac's browser profile. Those move only when you sync an
investigation to the team server, or export a backup and restore it.

The extension stays installed in whatever browser you actually work in. It
connects to any instance, so pointing it at the new host is a settings change,
not a reinstall.

---

## 2. Host requirements

The runtime stack is modest — roughly 400–600MB across Caddy, Node and
PostgreSQL. The *client build* is not: `tsc -b` plus a Vite bundle carrying
Excalidraw, Cytoscape and Mermaid peaks around 3–4GB.

That distinction drives the build strategy below. Check before you start:

```bash
free -m          # need ~4GB available to build in place
df -h /          # need ~5GB free for images and volumes
ss -lntp | grep -E ':80 |:443 '   # both must be free
```

A host that is already busy — a SOAR platform, a log pipeline, another
database — can easily have enough headroom to *run* ThreatCaddy while having
nowhere near enough to *build* it. Section 5 covers that case.

---

## 3. Provision the VM

Skip to §4 if you already have a Docker host.

Proxmox offers LXC or KVM. Use a VM: Docker inside LXC needs nesting enabled,
is officially discouraged, and tends to break across PVE upgrades. A VM also
snapshots cleanly, which matters more once real case data is in the database.

1. Create a VM — Debian 12 or Ubuntu 24.04, 2+ vCPU, 4GB+ RAM, 40GB+ disk.
2. Give it a static lease or reservation. The DNS records in §4 point here.
3. Install Docker Engine and the Compose plugin:

   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker "$USER"   # log out and back in
   docker compose version
   ```

4. Optionally add a Docker context on your Mac so you can drive it remotely
   instead of working over SSH:

   ```bash
   docker context create proxmox --docker "host=ssh://user@192.168.1.166"
   docker context use proxmox
   ```

---

## 4. Configure

### DNS

Two names must resolve to the VM. Splitting them lets the admin panel be
firewalled independently of the app.

| Name | Purpose |
|---|---|
| `threatcaddy.example.com` | Client and API |
| `admin.threatcaddy.example.com` | Admin panel |

For a public certificate, both must be reachable from the internet on ports
80 and 443 — forward them at your router. For a LAN-only deployment, point
internal DNS at the VM and use the `internal` issuer instead (§6).

### Environment

```bash
cp .env.example .env
```

Fill in, at minimum:

```bash
# Generate the database password and the JWT signing pair
openssl rand -base64 32                      # -> POSTGRES_PASSWORD
openssl genpkey -algorithm Ed25519 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem
awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' private.pem   # -> JWT_PRIVATE_KEY
awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' public.pem    # -> JWT_PUBLIC_KEY
```

`ALLOWED_ORIGINS` must match `TC_DOMAIN` exactly, scheme included — the server
rejects browser requests from anywhere else.

Keep `private.pem` somewhere safe and out of the repo (`*.pem` is gitignored).
Rotating the pair invalidates every existing session.

---

## 5. Build and start

### Standard: build on the host

```bash
docker compose -f docker-compose.selfhost.yml up -d --build
```

### Memory-constrained host: build the client on your Mac

If `free -m` showed less than ~4GB available, building in place will be
OOM-killed part-way through the Vite bundle. Build the client natively
instead — it is faster anyway — and ship the output:

```bash
pnpm install
pnpm build                    # produces dist/

TC_WEB_BUILD_TARGET=prebuilt \
  docker compose -f docker-compose.selfhost.yml up -d --build
```

The `prebuilt` target in `Dockerfile.web` copies your local `dist/` onto the
Caddy image rather than compiling inside it, so the remote build needs
essentially no memory. Everything else is identical.

`dist/` is intentionally *not* in `.dockerignore` for exactly this reason.

> Rebuild and redeploy the client after every `git pull`, or the container
> keeps serving the old bundle. The API image rebuilds normally either way.

### Verify

```bash
docker compose -f docker-compose.selfhost.yml ps
curl -sS https://threatcaddy.example.com/health
# {"status":"ok","db":"connected","storage":"accessible",...}
```

Database migrations run automatically at startup, so the schema is created on
first boot with no manual step.

### Create the first admin user

If you left `ADMIN_SECRET` blank, a random one is generated on first launch:

```bash
docker compose -f docker-compose.selfhost.yml exec server cat /data/files/.admin-secret
```

Use it at `https://admin.threatcaddy.example.com/admin`, then delete the file.

### Point the client at it

Open `https://threatcaddy.example.com`, go to **Settings → Team Server**, and
enter the same URL. Client and API are same-origin here deliberately: the CSP
in `index.html` restricts `connect-src` to `'self'`, so a client served from
one origin and talking to an API on another would be blocked by the browser
before the request ever left.

---

## 6. TLS

Caddy obtains and renews certificates automatically. `TC_TLS_ISSUER` picks how:

| Value | Use when |
|---|---|
| `acme` (default) | The names resolve publicly and 80/443 reach the VM |
| `internal` | LAN-only. Caddy issues from its own CA |

With `internal`, browsers will not trust the certificate until you install
Caddy's root once per client machine:

```bash
docker compose -f docker-compose.selfhost.yml cp \
  web:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
```

Trust it in Keychain Access on macOS, or the OS trust store elsewhere.

The `caddy-data` volume holds issued certificates. Losing it forces
re-issuance on every restart, which hits Let's Encrypt rate limits fast — keep
it in your backup set.

---

## 7. Hardening notes specific to this stack

- **The API has no published ports.** It is reachable only through Caddy, so
  TLS cannot be bypassed and the admin panel is never exposed on the LAN
  directly. Do not add a `ports:` mapping to the `server` service.
- **`TRUST_PROXY=1` is set deliberately.** Rate limiting keys off the client
  IP; behind a proxy every request appears to come from Caddy, so without it
  all clients share one bucket and the per-IP limits stop meaning anything.
  It is correct *only* because the server sits behind a proxy here.
- **`TC_ADMIN_ALLOW_IPS`** defaults to RFC1918. Narrow it to the management
  network you actually use. Requests from outside get a 404, not a 403 — a
  scanner learns nothing about whether an admin panel exists.
- **No analytics.** The Cloudflare beacon in `vite.config.ts` is gated behind
  `TC_ANALYTICS=1`, which only `pnpm deploy` sets. Self-hosted builds never
  fetch it, which also means the stack works air-gapped.

---

## 8. Backups

Two things carry state. Snapshotting the VM in Proxmox covers both, but a
consistent database dump is worth having independently:

```bash
# Database
docker compose -f docker-compose.selfhost.yml exec -T db \
  pg_dump -U tc threatcaddy | gzip > threatcaddy-$(date +%F).sql.gz

# Uploaded files
docker run --rm -v threatcaddy_file-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/files-$(date +%F).tar.gz -C /data .
```

Proxmox snapshots are the cheap safety net before an upgrade. Take one before
`git pull && docker compose up -d --build`.

See [backup-recovery.md](backup-recovery.md) for the application-level backup
and restore flow, which is what you would use to move client-side
investigation data onto the server in the first place.
