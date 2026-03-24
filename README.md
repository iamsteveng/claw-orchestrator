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
- An OpenClaw installation on the host with a valid auth profile
- Claude Code authenticated on the host (`~/.claude/.credentials.json`)
- A Slack app with a bot token and signing secret

---

## First-Time Deployment

### 1. Install dependencies

```bash
# Docker Engine
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs

# pnpm
npm install -g pnpm
```

### 2. Clone and build

```bash
git clone https://github.com/iamsteveng/claw-orchestrator.git /opt/claw-orchestrator
cd /opt/claw-orchestrator
pnpm install
pnpm build
```

### 3. Create data directories

```bash
sudo mkdir -p /data/claw-orchestrator /data/tenants
sudo chown -R $USER:$USER /data/claw-orchestrator /data/tenants
```

### 4. Configure environment

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

# Slack Relay
SLACK_RELAY_PORT=3000
SLACK_SIGNING_SECRET=<your-slack-signing-secret>
SLACK_BOT_TOKEN=xoxb-<your-bot-token>
CONTROL_PLANE_URL=http://localhost:3200

# Scheduler
SCHEDULER_INTERVAL_MS=60000
IDLE_STOP_HOURS=48
```

> **Model auth:** No `ANTHROPIC_API_KEY` goes here. OpenClaw model auth is provided via a read-only bind-mount of `~/.openclaw/agents/main/agent/auth-profiles.json` into each container. Claude Code auth is provided via `~/.claude/.credentials.json`. Both must exist on the host before starting.

### 5. Verify host auth files exist

```bash
test -f ~/.openclaw/agents/main/agent/auth-profiles.json \
  && echo "✓ OpenClaw auth OK" \
  || echo "✗ auth-profiles.json missing — run OpenClaw and authenticate first"

test -f ~/.claude/.credentials.json \
  && echo "✓ Claude Code auth OK" \
  || echo "✗ .credentials.json missing — run 'claude auth login' first"
```

### 6. Run database migrations

```bash
cd /opt/claw-orchestrator
npx prisma migrate deploy
```

### 7. Build the tenant Docker image

```bash
docker build \
  --build-arg IMAGE_TAG=sha-$(git rev-parse --short HEAD) \
  -t claw-tenant:latest \
  docker/tenant-image/
```

### 8. Add yourself to the allowlist

```bash
# POST to control plane allowlist (once it's running) or insert directly into DB:
sqlite3 /data/claw-orchestrator/db.sqlite \
  "INSERT INTO allowlist (id, team_id, user_id, created_at) VALUES (lower(hex(randomblob(8))), 'YOUR_TEAM_ID', 'YOUR_USER_ID', unixepoch() * 1000);"
```

### 9. Install and start systemd services

```bash
sudo cp deploy/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now claw-control-plane claw-slack-relay claw-scheduler
```

### 10. Open firewall ports

Slack requires your host to be publicly reachable over HTTPS. Open these ports in your firewall / AWS security group:

| Port | Protocol | Source | Purpose |
|------|----------|--------|---------|
| 443 | HTTPS | 0.0.0.0/0 | Slack webhook events (required) |
| 80 | HTTP | 0.0.0.0/0 | HTTP→HTTPS redirect (optional) |
| 22 | TCP | Your IP | SSH access |

> Ports 3000 (relay) and 3200 (control plane) stay **internal only** — never expose them publicly.

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
    reverse_proxy localhost:3000
}
```

```bash
sudo systemctl reload caddy
```

> **No domain?** Use `<ec2-ip>.nip.io` as your domain — e.g. `1.2.3.4.nip.io` — it resolves to your IP and works with Let's Encrypt.

### 11. Create the Slack app

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

This is the recommended deployment path for POC and production. Runs all three services in Docker Compose on a single EC2 instance, with a persistent EBS volume for data.

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
  docker.io docker-compose-plugin git curl

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

# Clone repo
git clone https://github.com/iamsteveng/claw-orchestrator.git /opt/claw-orchestrator
sudo chown -R ubuntu:ubuntu /opt/claw-orchestrator
```

### Step 3: Create the .env file

```bash
cp /opt/claw-orchestrator/.env.example /opt/claw-orchestrator/.env
nano /opt/claw-orchestrator/.env
```

Fill in:

```env
# Control Plane
CONTROL_PLANE_PORT=3200
DATABASE_URL=file:/data/tenants/orchestrator.db
DATA_DIR=/data/tenants
TENANT_IMAGE=claw-tenant:latest
TEMPLATES_DIR=/opt/claw-orchestrator/templates
LOG_LEVEL=info
NODE_ENV=production

# Slack Relay
SLACK_RELAY_PORT=3101
SLACK_SIGNING_SECRET=<your-slack-signing-secret>
SLACK_BOT_TOKEN=xoxb-<your-bot-token>
CONTROL_PLANE_URL=http://control-plane:3200

# Scheduler
SCHEDULER_INTERVAL_MS=60000
IDLE_STOP_HOURS=48
```

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

### Step 5: Build the tenant image

```bash
cd /opt/claw-orchestrator
docker build \
  --build-arg IMAGE_TAG=sha-$(git rev-parse --short HEAD) \
  -t claw-tenant:latest \
  docker/tenant-image/
```

### Step 6: Start the stack

```bash
cd /opt/claw-orchestrator
docker compose -f docker/docker-compose.test.yml up -d --build
docker compose -f docker/docker-compose.test.yml ps
```

Both `claw-cp-test` and `claw-relay-test` should show as `healthy`.

Verify:
```bash
curl http://localhost:13200/health  # {"ok":true,...}
curl http://localhost:13101/health  # {"ok":true,...}
```

### Step 7: Run database migrations + add yourself to allowlist

```bash
cd /opt/claw-orchestrator
DATABASE_URL=file:/data/tenants/orchestrator.db npx prisma migrate deploy

# Add yourself (get your Slack team/user IDs from the Slack app)
curl -s -X POST http://localhost:13200/v1/admin/allowlist \
  -H "content-type: application/json" \
  -d '{"slack_team_id":"T_YOUR_TEAM","slack_user_id":"U_YOUR_USER","added_by":"admin"}'
```

### Step 8: Configure Caddy

```bash
sudo nano /etc/caddy/Caddyfile
```

```
<elastic-ip>.nip.io {
    reverse_proxy localhost:13101
}
```

```bash
sudo systemctl reload caddy
```

Verify TLS is working:
```bash
curl https://<elastic-ip>.nip.io/health
```

### Step 9: Configure the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → your app → **Event Subscriptions**
2. Set Request URL: `https://<elastic-ip>.nip.io/slack/events`
3. Slack sends a challenge — the relay handles it automatically (wait for ✓ Verified)
4. Ensure `message.im` is subscribed under Bot Events
5. Save changes and reinstall the app to your workspace if prompted

### Step 10: Keep stack running across reboots

```bash
sudo tee /etc/systemd/system/claw-orchestrator.service > /dev/null <<EOF
[Unit]
Description=Claw Orchestrator (Docker Compose)
After=docker.service
Requires=docker.service

[Service]
User=ubuntu
WorkingDirectory=/opt/claw-orchestrator
ExecStart=docker compose -f docker/docker-compose.test.yml up
ExecStop=docker compose -f docker/docker-compose.test.yml down
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable claw-orchestrator
sudo systemctl start claw-orchestrator
```

### Verify end-to-end

Send yourself a DM in Slack. You should see:
1. Relay receives event → logs show incoming request
2. Control plane provisions tenant → container starts
3. User receives "Your workspace is ready!" DM
4. Second message → forwarded to container → agent responds

```bash
# Watch live
docker logs claw-cp-test -f
docker logs claw-relay-test -f
```

### Updating

Always use `--build` to ensure running containers reflect the latest code:

```bash
cd /opt/claw-orchestrator
git fetch origin main && git reset --hard origin/main
docker compose -f docker/docker-compose.test.yml up -d --build
docker build \
  --build-arg IMAGE_TAG=sha-$(git rev-parse --short HEAD) \
  -t claw-tenant:latest \
  docker/tenant-image/
```

> ⚠️ Never use `docker compose up -d` without `--build` after a code change — running containers will be stale even if the code on disk is updated.

### Auditing for stale state

Run the audit script to check for stale images, containers, volumes, or stuck tenants:

```bash
bash /opt/claw-orchestrator/scripts/audit.sh
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
cd /opt/claw-orchestrator
git pull
pnpm install && pnpm build
npx prisma migrate deploy
sudo systemctl restart claw-control-plane claw-slack-relay claw-scheduler
```

To rebuild the tenant image after updates:

```bash
docker build \
  --build-arg IMAGE_TAG=sha-$(git rev-parse --short HEAD) \
  -t claw-tenant:latest \
  docker/tenant-image/
```

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
  systemd/           # systemd unit files for all 3 services
SPEC.md              # Full technical specification (read this before hacking)
```

---

## Documentation

Full technical specification: [`SPEC.md`](./SPEC.md)
