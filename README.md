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

### 10. Configure Slack

- Set your Slack app's Event Subscriptions URL to: `https://<your-host>/slack/events`
- Subscribe to bot events: `message.im`, `app_mention`
- Install the app to your workspace

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
