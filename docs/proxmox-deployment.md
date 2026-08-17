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

**Both names must point at the VM's LAN address**, not at your WAN address.
That distinction matters more than it looks: many consumer routers do not
hairpin, so a LAN client that resolves the name to your public IP cannot
reach the VM behind it even though the port forward is correct.

Three ways to arrange that, in descending order of robustness.

#### 1. Split-horizon DNS (recommended)

A local resolver answers these names with the LAN address for internal
clients, leaving public DNS untouched. Works on every device automatically,
phones included, and is immune to rebinding filters.

**UniFi** (Network 8.x and later) — no extra infrastructure if you already
run a UniFi gateway, which is usually also the LAN's DNS server:

> Settings → Routing & DNS → DNS → **Create Entry**
> Record type `A`, hostname `threatcaddy.example.com`, value `192.168.1.166`.
> Repeat for the admin hostname.

Menu wording moves between releases; older builds have it under
Settings → Networks → *(network)* → DHCP Name Server, or a Custom DNS Record
section.

**Pi-hole v6** — Settings → Local DNS Records, then add one entry per
hostname. **Pi-hole v5** — Local DNS → DNS Records. Equivalent from the CLI:

```bash
echo "192.168.1.166 threatcaddy.example.com" | sudo tee -a /etc/pihole/custom.list
echo "192.168.1.166 admin.threatcaddy.example.com" | sudo tee -a /etc/pihole/custom.list
sudo pihole restartdns
```

A Pi-hole only takes effect if clients actually use it. Point DHCP at it —
on UniFi that is Settings → Networks → *(your network)* → DHCP Name Server →
Manual — otherwise clients keep querying the gateway and nothing changes.

> **Use an A record, not a CNAME.** Pi-hole offers both, and the CNAME form
> looks like it should work. It cannot: a CNAME target must be a hostname that
> itself resolves, so `tc.example.com CNAME 192.168.1.166.` dead-ends and
> clients get no address at all. The symptom is a name that "has a record" in
> Pi-hole yet still fails everywhere. Verify with
> `dig @<pihole> <name>` and check the record type in the ANSWER section.

Before pointing DHCP at any resolver, confirm it will actually serve your
clients:

```bash
dig @<resolver> example.com          # expect an address
```

`status: REFUSED` means it is answering local records but declining to
recurse, usually an access-control or listening-mode setting. Switching DHCP
to a resolver in that state takes DNS down for the whole network.

Local records take precedence over upstream, so answering a public name with
a private address here is fine and is not affected by upstream rebinding
protection.

#### 2. Point the public record at the private address

One edit at your DNS provider. Legal, and common for internal-only services.
Some resolvers and routers strip RFC1918 answers from public DNS as
anti-rebinding protection, which breaks resolution with no obvious clue.

#### 3. `/etc/hosts` per machine

No infrastructure, immediate, and useful for a first deployment before the
resolver is set up:

```bash
sudo tee -a /etc/hosts >/dev/null <<'HOSTS'

# ThreatCaddy (Proxmox)
192.168.1.166	threatcaddy.example.com
192.168.1.166	admin.threatcaddy.example.com
HOSTS
sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder   # macOS
```

Manual on every device and impossible on most phones, so treat it as a
stopgap.

> None of this affects certificates. DNS-01 validates through TXT records at
> your DNS provider, which is unrelated to what answers the A record — so a
> hosts file or a split-horizon override cannot break issuance or renewal.

### Environment

```bash
cp .env.example .env
```

Fill in, at minimum:

```bash
# Database password — hex, not base64 (see note below)
openssl rand -hex 32                         # -> POSTGRES_PASSWORD

# JWT signing pair
openssl genpkey -algorithm Ed25519 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem

# Append both keys quoted and multi-line, straight from the files
{ printf 'JWT_PRIVATE_KEY="'; cat private.pem; printf '"\n'
  printf 'JWT_PUBLIC_KEY="';  cat public.pem;  printf '"\n'; } >> .env
```

`POSTGRES_PASSWORD` must be URL-safe. It is interpolated into `DATABASE_URL`,
and `openssl rand -base64 32` emits `/`, `+` and `=`; a `/` terminates the URL
authority section and the server exits at startup with `ERR_INVALID_URL`.
`openssl rand -hex 32` gives the same 256 bits without the problem.

The PEM newlines must survive into the container. Compose preserves them
inside quotes; flattening the key to one line with literal `\n` escapes gets
rejected by `jose.importPKCS8` as `asn1 encoding routines::too long` — and
only on the first login, well after the server has started cleanly.

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

### Memory-constrained host: build nothing on the server

If `free -m` showed less than ~4GB available, building in place will be
OOM-killed part-way through. Two things are expensive, and neither has to
happen on the server:

```bash
# 1. Caddy with the IONOS DNS provider — fetched pre-built, no Go toolchain
./scripts/fetch-caddy.sh

# 2. The client bundle — built natively on your machine, which is faster anyway
pnpm install
pnpm build

# 3. The image build is then pure file copying
TC_WEB_BUILD_TARGET=prebuilt \
  docker compose -f docker-compose.selfhost.yml up -d --build
```

`scripts/fetch-caddy.sh` pulls a `linux/amd64` binary from Caddy's official
build service with `caddy-dns/ionos` compiled in. That avoids both a Go
toolchain and any cross-compilation, and it means the `prebuilt` target
compiles nothing at all.

This matters more than it sounds. A `xcaddy` build wants 1–2GB and the Vite
bundle rather more; running either on a server that is already hosting other
services can starve them badly enough to take them offline. Keep compilation
off the deployment host.

`dist/` and `caddy-bin/` are intentionally *not* in `.dockerignore` for exactly
this reason — both are inputs to the `prebuilt` target.

> Re-run steps 1–3 after every `git pull`, or the container keeps serving the
> old bundle. The API image rebuilds normally either way.

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

TLS is not optional here. `crypto.subtle` is only exposed in a secure context,
so served over plain HTTP the client loses at-rest encryption, encrypted
backups and sharing — `isSecureContext()` in `src/lib/crypto.ts` gates them and
the UI shows an "HTTPS required" warning. A LAN deployment still needs a
certificate.

`TC_TLS_MODE` selects how Caddy gets one:

| Mode | Inbound needed | Trusted by clients | Use when |
|---|---|---|---|
| `dns-ionos` | none | yes | The domain is at IONOS. Best option for a LAN-only host |
| `internal` | none | after installing the root | No domain, or no API token |
| `acme-http` | ports 80 + 443 | yes | Publicly reachable host |

### dns-ionos — trusted certificates without inbound traffic

ACME normally proves control by answering on port 80. A residential ISP that
blocks inbound traffic makes that impossible. The DNS-01 challenge proves
control by publishing a TXT record instead, which needs no inbound
connectivity at all — so a machine that is entirely unreachable from the
internet can still hold a publicly trusted certificate.

Stock Caddy cannot do this; the DNS provider must be compiled in. Run
`./scripts/fetch-caddy.sh`, which downloads a binary with
`caddy-dns/ionos` already built in from Caddy's official build service — no Go
toolchain and no compilation on either machine. (The `full` build target
compiles it with `xcaddy` instead, for hosts with the memory to spare.)

Create a token in the IONOS DNS dashboard with permission to write TXT
records on the zone, then:

```env
TC_TLS_MODE=dns-ionos
TC_IONOS_API_TOKEN=<public-prefix>.<secret>
```

Renewal is automatic and needs no further inbound access, so this keeps
working indefinitely behind a hostile ISP.

> Use the staging directory on the first run — see below. A wrong token fails
> validation, and production rate limits are unforgiving.

### internal — Caddy's own CA

No external dependency and no token, but every client must trust the root
certificate once:

```bash
docker compose -f docker-compose.selfhost.yml cp \
  web:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
```

Trust it in Keychain Access on macOS, or the OS trust store elsewhere. This
is the awkward part on phones and tablets, which is why `dns-ionos` is
preferable when the domain allows it.

### Deploy against staging first

Let's Encrypt production permits only a handful of failed validations per
hostname per hour. A wrong token or a DNS record that has not propagated will
exhaust that before you have finished diagnosing it, and then you wait.

So prove the path against staging:

```bash
TC_ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory
```

Bring the stack up and watch for issuance:

```bash
docker compose -f docker-compose.selfhost.yml logs -f web | grep -i "certificate obtained"
```

Browsers will not trust a staging certificate — that warning is expected and
means it worked. Once you see issuance succeed, clear `TC_ACME_CA`, restart
the `web` service, and you get a real certificate on the first attempt.

The `caddy-data` volume holds issued certificates. Losing it forces
re-issuance on every restart, which hits rate limits fast — keep it in your
backup set.

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
