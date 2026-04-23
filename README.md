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

### Quick start (one command)

`bootstrap.sh` handles everything that can be automated on a fresh Ubuntu host: system dependencies, repository clone, `.env` setup, the full installer, and optional HTTPS via Caddy.

**Before you run it**, make sure these host-side auth files exist:

| File | How to create it |
| --- | --- |
| `~/.openclaw/agents/main/agent/auth-profiles.json` | Run `openclaw auth` on the host |
| `~/.claude/.credentials.json` | Run `claude` on the host to log in |

Tenant containers need both at runtime. The script will warn (not block) if they are missing.

```bash
git clone https://github.com/iamsteveng/claw-orchestrator.git ~/claw-orchestrator
cd ~/claw-orchestrator

bash deploy/scripts/bootstrap.sh \
  --signing-secret <your-slack-signing-secret> \
  --bot-token xoxb-<your-bot-token> \
  --domain your-domain.example
```

Omit `--domain` if you are setting up HTTPS separately. Pass `--skip-validation` to skip the post-install smoke test.

What the script does:

1. Installs Docker, Node.js 22, pnpm, sqlite3, git (skips each if already present)
2. Handles the Docker group activation — re-launches itself under `sg docker` so `docker build` works without a logout/login
3. Clones the repo (skips if the directory already exists)
4. Writes `.env` with the provided secrets
5. Runs `deploy/scripts/install.sh` (see [what install.sh does](#what-installsh-does))
6. Installs Caddy and writes `/etc/caddy/Caddyfile` if `--domain` is given

After bootstrap completes, continue from [Create the Slack app](#3-create-the-slack-app).

---

### Manual installation

Use this path if you need full control over each step, or if dependencies are already managed by your provisioning tooling.

#### 1. Install host dependencies

```bash
# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker   # activate group in current session without logout

# Node.js 22 + required packages
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs sqlite3 git curl

# pnpm
sudo npm install -g pnpm
```

#### 2. Clone the repository and configure `.env`

```bash
git clone https://github.com/iamsteveng/claw-orchestrator.git ~/claw-orchestrator
cd ~/claw-orchestrator
cp .env.example .env
```

Edit `.env` and set at minimum:

```env
SLACK_SIGNING_SECRET=<your-slack-signing-secret>
SLACK_BOT_TOKEN=xoxb-<your-bot-token>
```

All other values have working defaults. Important notes:

- Leave `TEMPLATES_DIR` unset — `install.sh` sets it to the checkout-relative `templates/workspace` path automatically.
- Do **not** put `ANTHROPIC_API_KEY` in `.env`; model auth comes from the host OpenClaw profile file (see auth files above).

#### 3. Run the installer {#what-installsh-does}

```bash
bash deploy/scripts/install.sh
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
9. runs `scripts/validate-deployment.sh` unless `--skip-validation` is passed

#### 4. Put HTTPS in front of the Slack relay

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

---

### 3. Create the Slack app

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

### 4. Allowlist the first user

```bash
sqlite3 /data/claw-orchestrator/db.sqlite \
  "INSERT INTO allowlist (id, slack_team_id, slack_user_id, added_by, created_at) VALUES (lower(hex(randomblob(8))), 'YOUR_TEAM_ID', 'YOUR_USER_ID', 'admin', unixepoch() * 1000);"
```

### 5. Validate the deployment

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

## Local Testing with Docker Compose

Run the full validation stack locally without real Slack or LLM credentials.

### Prerequisites

- Docker and `docker compose`
- `jq`, `sqlite3`, `curl`
- Host ports **13200** and **13101** free

> **Port coexistence:** The compose test stack publishes to host ports 13200 and 13101 specifically so it can run alongside production systemd services bound to 3200/3101. Do not change these defaults on a deploy host.

> **Data isolation:** Test tenant state lives under `/tmp/claw-local-test/data`, not `/data/tenants`. The compose stack never touches production tenant data.

> **Image isolation:** Local testing builds and uses `claw-tenant:local-test`. It never modifies `claw-tenant:latest` (the production tag).

### Usage

```bash
# Default: sections 1-4, stub credentials, HTTPS check skipped
bash scripts/local-test.sh

# Sections 1-5: requires real ~/.openclaw/... and ~/.claude/.credentials.json + LLM access
bash scripts/local-test.sh --full

# Sections 1-6: requires real Slack signing secret in repo .env
bash scripts/local-test.sh --slack

# Debugging: stack stays up after run
bash scripts/local-test.sh --keep

# Force rebuild of tenant image and compose services
bash scripts/local-test.sh --rebuild

# Strict: abort if claw-* systemd services are active (default is warning-only)
bash scripts/local-test.sh --check-clean

# Run specific sections only
bash scripts/local-test.sh --sections "1 2"
```

### State and cleanup

All test state lives under `/tmp/claw-local-test/` and is automatically removed on exit (unless `--keep`). A `--keep` run persists the compose stack; the next non-`--keep` run tears it down.

### Validator env-override vars

`validate-deployment.sh` accepts these env vars (all optional — defaults match production):

| Variable | Default | Purpose |
|---|---|---|
| `CP_URL` | `http://localhost:3200` | Control-plane base URL |
| `RELAY_URL` | `http://localhost:3101` | Relay base URL |
| `RELAY_LOCAL_URL` | `http://localhost:3101/slack/events` | Relay events URL |
| `SKIP_HTTPS_CHECK` | `0` | Set to `1` to skip the HTTPS reachability probe |
| `AUTH_PROFILES` | derived from env `HOME` | Path to `auth-profiles.json` |
| `CREDS` | derived from env `HOME` | Path to `.credentials.json` |
| `TENANT_IMAGE` | `claw-tenant:latest` | Tenant Docker image tag |
| `CLAW_RUNTIME_ENV_FILE` | `/etc/claw-orchestrator/env` | Env file for the validator |

---

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
