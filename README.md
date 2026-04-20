# Claw Orchestrator

Claw Orchestrator runs isolated [OpenClaw](https://openclaw.ai) workspaces for Slack users on a single Linux host. Each approved user gets a dedicated Docker container with its own filesystem, workspace templates, CLI state, and credentials boundary, while the host control plane handles provisioning, routing, and cleanup.

It is designed for small-team or internal deployments where you want a repeatable way to host personal agent environments behind a Slack DM interface.

## What you get

- **Per-user isolation** — each tenant runs in its own container with a separate workspace and runtime state.
- **Slack entrypoint** — users message the bot in Slack and are routed to their own environment.
- **Repeatable deployment** — `deploy/scripts/install.sh` and `deploy/scripts/update.sh` install and update the systemd-managed stack from any checkout path.
- **Host-managed lifecycle** — the scheduler stops idle tenants, enforces retention rules, and helps keep the host clean.
- **Template-driven workspaces** — tenant workspaces are seeded from `templates/workspace/` at provision time.

## System architecture

Three host-side services make up the deployment:

| Service | Responsibility |
| --- | --- |
| `slack-relay` | Verifies Slack requests and routes inbound messages to the correct tenant |
| `control-plane` | Provisions, starts, stops, and deletes tenant containers |
| `scheduler` | Stops idle containers, enforces cleanup policies, and reaps stale state |

Each tenant container is built from `docker/tenant-image/` and includes OpenClaw, Claude Code, GitHub CLI, and the pre-seeded workspace template.

## Recommended host profile

The project targets a single Linux host. A good baseline for evaluation or small-team use is:

| Resource | Recommendation |
| --- | --- |
| OS | Ubuntu 24.04 LTS |
| CPU / RAM | `t4g.small` for light testing, `t4g.2xlarge` for ~10 active users |
| Persistent data | Dedicated volume mounted at `/data` |
| Public ingress | HTTPS endpoint for Slack events |
| Runtime | Docker Engine + systemd |

If you deploy on AWS, use an Elastic IP (or a stable DNS record) so your Slack request URL does not change.

If you deploy on an EC2 instance, allow inbound TCP ports `22`, `80`, and `443` in the instance security group: `22` for SSH access, and `80`/`443` so your reverse proxy can receive Slack webhook traffic and serve HTTPS.

## Installation guide

This is the fastest path to a fresh deployment on an Ubuntu host.

### 1. Install host dependencies

```bash
# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Node.js 22 + required packages
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs sqlite3 git curl

# pnpm
sudo npm install -g pnpm
```

### 2. Clone the repository

```bash
git clone https://github.com/iamsteveng/claw-orchestrator.git ~/claw-orchestrator
cd ~/claw-orchestrator
```

### 3. Create and fill in `.env`

```bash
cp .env.example .env
```

At minimum, configure these values:

```env
# Control Plane
CONTROL_PLANE_PORT=3200
DATABASE_URL=file:/data/claw-orchestrator/db.sqlite
DATA_DIR=/data/tenants
TENANT_IMAGE=claw-tenant:latest
LOG_LEVEL=info
MAX_ACTIVE_TENANTS=10
ACTIVE_TENANTS_OVERFLOW_POLICY=queue

# Slack Relay
SLACK_RELAY_PORT=3101
SLACK_SIGNING_SECRET=<your-slack-signing-secret>
SLACK_BOT_TOKEN=xoxb-<your-bot-token>
CONTROL_PLANE_URL=http://localhost:3200

# Scheduler
SCHEDULER_INTERVAL_MS=60000
IDLE_STOP_HOURS=48
```

Important notes:

- `deploy/scripts/install.sh` and `deploy/scripts/update.sh` render `/etc/claw-orchestrator/env` from `deploy/systemd/claw-orchestrator.env` plus supported keys from your repo `.env`.
- Leave `TEMPLATES_DIR` unset unless you intentionally want to override the default checkout-relative `templates/workspace` path.
- Do **not** put `ANTHROPIC_API_KEY` in `.env`; model auth comes from the host OpenClaw profile file.

### 4. Verify host auth files

Tenant containers expect these host-side credentials to exist before first boot:

```bash
test -f ~/.openclaw/agents/main/agent/auth-profiles.json \
  && echo "✓ OpenClaw auth OK" \
  || echo "✗ Missing ~/.openclaw/agents/main/agent/auth-profiles.json"

test -f ~/.claude/.credentials.json \
  && echo "✓ Claude Code auth OK" \
  || echo "✗ Missing ~/.claude/.credentials.json"
```

If they are missing, authenticate OpenClaw and Claude Code on the host first.

### 5. Run the installer

```bash
bash deploy/scripts/install.sh
```

Optional:

```bash
bash deploy/scripts/install.sh --skip-validation
```

The install script performs the full first-time setup:

1. validates required tools and Slack secrets
2. creates `/data/*` directories and the `claw` system user
3. installs `/etc/claw-orchestrator/env`
4. installs dependencies and builds the monorepo
5. builds the `claw-tenant:latest` image
6. runs Prisma migrations
7. installs and starts the systemd services
8. waits for `/health` on ports `3200` and `3101`
9. runs `scripts/validate-deployment.sh` unless skipped

### 6. Put HTTPS in front of the Slack relay

Slack must reach your deployment over HTTPS. Keep `3101` and `3200` internal and publish only your reverse proxy.

Caddy is the easiest option:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```caddy
your-domain.example {
    reverse_proxy localhost:3101
}
```

```bash
sudo systemctl reload caddy
```

If you do not have DNS yet, `<public-ip>.nip.io` works well for quick setup.

### 7. Create the Slack app

Use Slack's **From a manifest** flow so app creation is repeatable. Replace `your-domain.example` before submitting:

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
      "request_url": "https://your-domain.example/slack/events",
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

Then:

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app **from a manifest**.
2. Install it to your workspace.
3. Copy the generated bot token and signing secret into `.env`.
4. Restart the relay if needed:

```bash
sudo systemctl restart claw-slack-relay
```

### 8. Allowlist the first user

```bash
sqlite3 /data/claw-orchestrator/db.sqlite \
  "INSERT INTO allowlist (id, slack_team_id, slack_user_id, added_by, created_at) VALUES (lower(hex(randomblob(8))), 'YOUR_TEAM_ID', 'YOUR_USER_ID', 'admin', unixepoch() * 1000);"
```

### 9. Validate the deployment

Recommended checks:

```bash
sudo systemctl status claw-control-plane claw-slack-relay claw-scheduler
curl -fsS http://localhost:3200/health
curl -fsS http://localhost:3101/health
bash scripts/audit.sh
```

Then send the Slack bot a DM and confirm:

1. the relay receives the event
2. a tenant container is provisioned or resumed
3. the user receives a workspace-ready response
4. follow-up messages are routed into the tenant

## Updating an existing deployment

Use the repeatable update flow:

```bash
bash deploy/scripts/update.sh
```

Optional:

```bash
bash deploy/scripts/update.sh --skip-validation
```

`deploy/scripts/update.sh` performs:

1. a backup when the database exists
2. service shutdown in reverse dependency order
3. a safe `git fetch` + fast-forward update when possible
4. dependency install, build, image rebuild, and Prisma migration
5. regeneration of `/etc/claw-orchestrator/env`
6. service restart, health checks, and optional validation

If the local branch is ahead of upstream, the script skips the pull and logs a warning instead of overwriting local commits.

## Day-2 operations

### Service management

```bash
# Status
sudo systemctl status claw-control-plane claw-slack-relay claw-scheduler

# Logs
sudo journalctl -u claw-control-plane -f
sudo journalctl -u claw-slack-relay -f
sudo journalctl -u claw-scheduler -f

# Restart one service
sudo systemctl restart claw-control-plane
```

### Audit for stale state

```bash
bash scripts/audit.sh
```

The audit script checks for stale images, orphaned containers, stale volumes, stuck tenants, and environment mismatches.

### Open a shell in a tenant container

```bash
bash scripts/tenant-shell.sh <tenant-id>
```

### Refresh bundled Ralph skills

```bash
bash scripts/update-ralph-skills.sh /path/to/ralph-repo
docker build --build-arg IMAGE_TAG=sha-$(git rev-parse --short HEAD) -t claw-tenant:latest docker/tenant-image/
```

## Repository layout

```text
apps/
  control-plane/     # Fastify HTTP API
  scheduler/         # Idle stop, cleanup, quota enforcement
  slack-relay/       # Slack event receiver
packages/
  docker-client/     # Docker CLI wrapper
  shared-config/     # Zod-validated environment config
  shared-types/      # Shared TypeScript types
  test-utils/        # Shared test helpers
docker/
  tenant-image/      # Tenant container build context
deploy/
  scripts/           # Fresh install and in-place update entrypoints
  systemd/           # Service unit templates and runtime env template
templates/
  workspace/         # Files seeded into each tenant workspace
scripts/
  audit.sh           # Deployment audit helper
  tenant-shell.sh    # Tenant debug shell helper
SPEC.md              # Full technical specification
```

## Further reading

- Full technical specification: [`SPEC.md`](./SPEC.md)
- Example runtime configuration: [`.env.example`](./.env.example)
