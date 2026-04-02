# Claw Orchestrator

A multi-tenant control plane that gives each Slack user their own isolated [OpenClaw](https://openclaw.ai) agent runtime in a Docker container on a single Linux host.

Each user gets their own container with a fully isolated filesystem, workspace, SSH keys, CLI sessions, and agent state. No user can touch another user's environment.

---

## Architecture

Three services run on the host:

| Service | Role |
|---|---|
| `slack-relay` | Receives Slack events, verifies signatures, routes messages to the right tenant |
| `control-plane` | Provisions, starts, stops, and deletes tenant containers; manages lifecycle |
| `scheduler` | Stops idle containers (48h), enforces disk quotas, reaps stale queue entries |

Each tenant gets a Docker container built from `docker/tenant-image/` with OpenClaw, Claude Code, GitHub CLI, and the 6 Ralph agent skills pre-installed.

---

## Prerequisites

- Linux host (AWS EC2 recommended: `t4g.2xlarge` for ~10 users)
- Docker Engine
- Node.js 22 + pnpm
- `sqlite3`
- `git`
- `sudo` access for the deploying user
- An OpenClaw installation on the host with a valid auth profile
- Claude Code authenticated on the host (`~/.claude/.credentials.json`)
- A Slack app with a bot token and signing secret

## Deployment Notes

The checked-in deployment assets are now template-based:

- `deploy/systemd/*.service` and `deploy/systemd/claw-orchestrator.env` use a `__REPO_DIR__` placeholder
- `deploy/scripts/install.sh` / `deploy/scripts/update.sh` render that placeholder to the actual checkout path at install time
- `/etc/claw-orchestrator/env` is regenerated from the tracked template plus the supported matching keys from repo `.env`

That means you can clone the repo wherever you want; the deployment scripts render relocatable systemd assets from the current checkout.

---

## First-Time Deployment

### 1. Install dependencies

```bash
# Docker Engine
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs sqlite3 git

# pnpm
sudo npm install -g pnpm
```

### 2. Clone the repo

```bash
git clone https://github.com/iamsteveng/claw-orchestrator.git ~/claw-orchestrator
cd ~/claw-orchestrator
```

### 3. Configure `.env`

```bash
cp .env.example .env
```

Edit `.env` and fill in:

```env
# Control Plane
CONTROL_PLANE_PORT=3200
DATABASE_URL=file:/data/claw-orchestrator/db.sqlite
DATA_DIR=/data/tenants
TENANT_IMAGE=claw-tenant:latest
LOG_LEVEL=info
NODE_ENV=production

# Slack Relay
SLACK_RELAY_PORT=3101
SLACK_SIGNING_SECRET=<your-slack-signing-secret>
SLACK_BOT_TOKEN=xoxb-<your-bot-token>
CONTROL_PLANE_URL=http://localhost:3200

# Scheduler
SCHEDULER_INTERVAL_MS=60000
IDLE_STOP_HOURS=48
```

> **Important:** `install.sh` / `update.sh` render `/etc/claw-orchestrator/env` from the tracked template in `deploy/systemd/claw-orchestrator.env`, then sync the supported matching runtime keys from repo `.env` into that file. Leave `TEMPLATES_DIR` unset for the normal flow unless you intentionally want to override the default `<repo checkout>/templates/workspace`.

> **Model auth:** No `ANTHROPIC_API_KEY` goes here. OpenClaw model auth is provided via a read-only bind-mount of `~/.openclaw/agents/main/agent/auth-profiles.json` into each container. Claude Code auth is provided via `~/.claude/.credentials.json`. Both must exist on the host before starting.

### 4. Verify host auth files exist

```bash
test -f ~/.openclaw/agents/main/agent/auth-profiles.json \
  && echo "✓ OpenClaw auth OK" \
  || echo "✗ auth-profiles.json missing — run OpenClaw and authenticate first"

test -f ~/.claude/.credentials.json \
  && echo "✓ Claude Code auth OK" \
  || echo "✗ .credentials.json missing — run 'claude auth login' first"
```

### 5. Run the repeatable install script

```bash
cd ~/claw-orchestrator
bash deploy/scripts/install.sh
```

Optional:

```bash
bash deploy/scripts/install.sh --skip-validation
```

The install script:

1. validates required tools and Slack secrets
2. creates `/data/*` directories and the `claw` system user
3. installs `/etc/claw-orchestrator/env`
4. installs dependencies and builds the monorepo
5. builds `claw-tenant:latest`
6. runs Prisma migrations
7. installs/enables systemd services and starts them
8. waits for `/health` on ports `3200` and `3101`
9. runs `scripts/validate-deployment.sh` unless `--skip-validation` is passed

### 6. Add yourself to the allowlist

```bash
sqlite3 /data/claw-orchestrator/db.sqlite \
  "INSERT INTO allowlist (id, team_id, user_id, created_at) VALUES (lower(hex(randomblob(8))), 'YOUR_TEAM_ID', 'YOUR_USER_ID', unixepoch() * 1000);"
```

### 7. Open firewall ports and configure a reverse proxy

Slack requires your host to be publicly reachable over HTTPS. Open these ports in your firewall / AWS security group:

| Port | Protocol | Source | Purpose |
|------|----------|--------|---------|
| 443 | HTTPS | 0.0.0.0/0 | Slack webhook events (required) |
| 80 | HTTP | 0.0.0.0/0 | HTTP→HTTPS redirect (optional) |
| 22 | TCP | Your IP | SSH access |

> Ports `3101` (relay) and `3200` (control plane) stay **internal only** — never expose them publicly.

**Set up a reverse proxy (Caddy recommended — handles TLS automatically):**

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

Edit `/etc/caddy/Caddyfile`:

```
your-domain.com {
    reverse_proxy localhost:3101
}
```

```bash
sudo systemctl reload caddy
```

> **No domain?** Use `<ec2-ip>.nip.io` as your domain — e.g. `1.2.3.4.nip.io` — it resolves to your IP and works with Let's Encrypt.

### 8. Create the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**
2. Select your workspace and paste this manifest:

```json
{
  "display_information": {
    "name": "Claw Orchestrator",
    "description": "Your personal AI agent — powered by OpenClaw",
    "background_color": "#1a1a2e"
  },
  "features": {
    "bot_user": {
      "display_name": "Claw",
      "always_online": true
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "im:history",
        "im:read",
        "im:write",
        "users:read"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "request_url": "https://your-domain.com/slack/events",
      "bot_events": [
        "message.im"
      ]
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

3. Replace `your-domain.com` with your actual domain.
4. Click **Create App** → **Install to Workspace** → authorize.
5. Copy credentials into `.env`:
   - **Bot Token** (`xoxb-...`) → **OAuth & Permissions** → `SLACK_BOT_TOKEN`
   - **Signing Secret** → **Basic Information** → `SLACK_SIGNING_SECRET`
6. Restart the relay: `sudo systemctl restart claw-slack-relay`

---

## Deploying on AWS EC2 (Recommended)

This is the recommended deployment path for POC and production. Use the repeatable `deploy/scripts/install.sh` and `deploy/scripts/update.sh` flow on a single EC2 instance, with a persistent EBS volume for data.

### Infrastructure

| Resource | Spec |
|----------|------|
| Instance | `t4g.small` (arm64, 2GB RAM) — upgrade to `t4g.2xlarge` for ~10 users |
| OS | Ubuntu 24.04 LTS arm64 |
| Root EBS | 20GB `gp3` (OS + Docker images) |
| Data EBS | 20GB `gp3`, mounted at `/data` (SQLite DB + tenant workspaces — survives instance replacement) |
| Elastic IP | Static IP — required so the Slack webhook URL never changes |
| Domain | Use `<elastic-ip>.nip.io` (e.g. `54.12.34.56.nip.io`) — no DNS setup needed, works with Let's Encrypt |

**Security group rules:**

| Port | Protocol | Source | Purpose |
|------|----------|--------|---------|
| 22 | TCP | Your IP | SSH |
| 80 | TCP | 0.0.0.0/0 | HTTP → HTTPS redirect (Caddy) |
| 443 | TCP | 0.0.0.0/0 | HTTPS — Slack webhooks |

Ports 3200 (control-plane) and 3101 (relay) stay internal — never expose them publicly.

### Step 1: Launch the EC2 instance

1. Launch `t4g.small` with Ubuntu 24.04 LTS arm64
2. Attach your SSH key pair
3. Attach the security group above
4. Add a second EBS volume (20GB `gp3`) — this will be `/data`
5. Allocate an Elastic IP and associate it with the instance

### Step 2: Bootstrap the instance

SSH in and run:

```bash
ssh ubuntu@<elastic-ip>

# System deps
sudo apt-get update && sudo apt-get install -y \
  docker.io git curl sqlite3

# Add ubuntu to docker group
sudo usermod -aG docker ubuntu
newgrp docker

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs
sudo npm install -g pnpm

# Caddy (reverse proxy + auto TLS)
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

# Mount data volume (replace nvme1n1 with your device name — check with `lsblk`)
sudo mkfs.ext4 /dev/nvme1n1
sudo mkdir -p /data
sudo mount /dev/nvme1n1 /data
echo "/dev/nvme1n1 /data ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab
sudo mkdir -p /data/tenants
sudo chown -R ubuntu:ubuntu /data

# Clone repo anywhere convenient (install/update render the actual checkout path into systemd assets)
git clone https://github.com/iamsteveng/claw-orchestrator.git ~/claw-orchestrator
sudo chown -R ubuntu:ubuntu ~/claw-orchestrator
```

### Step 3: Create the .env file

```bash
cp ~/claw-orchestrator/.env.example ~/claw-orchestrator/.env
nano ~/claw-orchestrator/.env
```

Fill in:

```env
# Control Plane
CONTROL_PLANE_PORT=3200
DATABASE_URL=file:/data/claw-orchestrator/db.sqlite
DATA_DIR=/data/tenants
TENANT_IMAGE=claw-tenant:latest
LOG_LEVEL=info
NODE_ENV=production

# Slack Relay
SLACK_RELAY_PORT=3101
SLACK_SIGNING_SECRET=<your-slack-signing-secret>
SLACK_BOT_TOKEN=xoxb-<your-bot-token>
CONTROL_PLANE_URL=http://localhost:3200

# Scheduler
SCHEDULER_INTERVAL_MS=60000
IDLE_STOP_HOURS=48
```

> `install.sh` / `update.sh` regenerate `/etc/claw-orchestrator/env` from the tracked template and then sync the supported matching keys from repo `.env`. Leave `TEMPLATES_DIR` unset unless you explicitly want to override the default checkout-relative templates path.

### Step 4: Copy auth files from your local machine

OpenClaw model auth and Claude Code auth are bind-mounted into each tenant container. They must exist on the host before starting.

From your **local machine**:

```bash
# Copy OpenClaw auth
scp ~/.openclaw/agents/main/agent/auth-profiles.json ubuntu@<elastic-ip>:~/.openclaw/agents/main/agent/

# Copy Claude Code credentials
scp ~/.claude/.credentials.json ubuntu@<elastic-ip>:~/.claude/
```

Or on the EC2 instance, authenticate directly:
```bash
# OpenClaw — run openclaw and authenticate
# Claude Code
claude auth login
```

Verify both exist:
```bash
test -f ~/.openclaw/agents/main/agent/auth-profiles.json && echo "✓ OpenClaw auth OK"
test -f ~/.claude/.credentials.json && echo "✓ Claude Code auth OK"
```

### Step 5: Run the install script

```bash
cd ~/claw-orchestrator
bash deploy/scripts/install.sh
```

This will build the repo, build `claw-tenant:latest`, install `/etc/claw-orchestrator/env`, install/reload the systemd units, start services, wait for health checks, and run deployment validation.

### Step 6: Add yourself to the allowlist

```bash
sqlite3 /data/claw-orchestrator/db.sqlite \
  "INSERT INTO allowlist (id, team_id, user_id, created_at) VALUES (lower(hex(randomblob(8))), 'YOUR_TEAM_ID', 'YOUR_USER_ID', unixepoch() * 1000);"
```

### Step 7: Configure Caddy

```bash
sudo nano /etc/caddy/Caddyfile
```

```
<elastic-ip>.nip.io {
    reverse_proxy localhost:3101
}
```

```bash
sudo systemctl reload caddy
```

Verify TLS is working:
```bash
curl https://<elastic-ip>.nip.io/health
```

### Step 8: Configure the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → your app → **Event Subscriptions**
2. Set Request URL: `https://<elastic-ip>.nip.io/slack/events`
3. Slack sends a challenge — the relay handles it automatically (wait for ✓ Verified)
4. Ensure `message.im` is subscribed under Bot Events
5. Save changes and reinstall the app to your workspace if prompted

### Step 9: Verify end-to-end

Send yourself a DM in Slack. You should see:
1. Relay receives event → logs show incoming request
2. Control plane provisions tenant → container starts
3. User receives "Your workspace is ready!" DM
4. Second message → forwarded to container → agent responds

```bash
sudo systemctl status claw-control-plane claw-slack-relay claw-scheduler
sudo journalctl -u claw-control-plane -f
sudo journalctl -u claw-slack-relay -f
```

### Auditing for stale state

Run the audit script to check for stale images, containers, volumes, or stuck tenants:

```bash
cd ~/claw-orchestrator
bash scripts/audit.sh
```

The audit checks:
- Image version labels vs current git HEAD (catches stale images that weren't rebuilt after `git pull`)
- Orphaned tenant containers
- Stale Docker volumes
- Stuck tenants in DB (STARTING/FAILED with no running container)
- CONTAINER_NETWORK and HOST_DATA_DIR env vars set correctly

---

## Updating

```bash
cd ~/claw-orchestrator
bash deploy/scripts/update.sh
```

Optional:

```bash
bash deploy/scripts/update.sh --skip-validation
```

`deploy/scripts/update.sh` now performs:

1. a pre-deploy backup to `/data/backups/YYYY-MM-DD/` when the DB exists
2. service stop in reverse dependency order
3. a safe `git fetch` + fast-forward merge when possible
4. dependency install, build, tenant image rebuild, and Prisma migration
5. regeneration of `/etc/claw-orchestrator/env` from the tracked template plus the supported matching repo `.env` overrides
6. systemd unit reinstall/reload, service start, health checks, and optional validation

If the local branch is ahead of upstream, the script skips the pull and logs a warning. If the branch has diverged, it exits and asks for manual resolution before redeploying.

---

## Updating Ralph Skills

When the [ralph](https://github.com/iamsteveng/ralph) skills are updated, sync them into the build context and rebuild the image:

```bash
bash scripts/update-ralph-skills.sh /path/to/ralph-repo
docker build --build-arg IMAGE_TAG=sha-$(git rev-parse --short HEAD) -t claw-tenant:latest docker/tenant-image/
```

---

## Service Management

```bash
# Status
sudo systemctl status claw-control-plane claw-slack-relay claw-scheduler

# Logs
sudo journalctl -u claw-control-plane -f
sudo journalctl -u claw-slack-relay -f
sudo journalctl -u claw-scheduler -f

# Restart individual service
sudo systemctl restart claw-control-plane
```

---

## Interactive Tenant Access (Debug)

To open a shell in a tenant's container:

```bash
bash scripts/tenant-shell.sh <tenant-id>
```

---

## Repository Structure

```
apps/
  control-plane/     # Fastify HTTP API
  slack-relay/       # Slack event receiver
  scheduler/         # Idle stop, disk quota, queue reaping
packages/
  shared-types/      # TypeScript types
  shared-config/     # Zod-validated env config
  docker-client/     # Docker CLI wrapper (execa)
  test-utils/        # Shared test helpers
docker/
  tenant-image/      # Dockerfile + entrypoint + Ralph scripts + skills
prisma/
  schema.prisma      # 6 tables: tenants, message_queue, startup_locks, audit_log, allowlist, container_images
scripts/
  update-ralph-skills.sh   # Syncs Ralph skills from ralph repo
  tenant-shell.sh          # Opens a shell in a tenant container
templates/
  workspace/
    AGENTS.md        # Pre-seeded into every tenant workspace at provisioning time
deploy/
  scripts/
    install.sh       # Fresh-install entrypoint for repeatable deployment
    update.sh        # Safe in-place update entrypoint with backup + health checks
  systemd/           # systemd unit files for all 3 services
SPEC.md              # Full technical specification (read this before hacking)
```

---

## Documentation

Full technical specification: [`SPEC.md`](./SPEC.md)
