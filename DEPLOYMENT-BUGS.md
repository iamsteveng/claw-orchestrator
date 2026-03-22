# Deployment Bug Report — 2026-03-22

## What Works ✅

1. **Tenant provisioning** — Slack event → relay → control plane → Docker container created → OpenClaw gateway starts → tenant ACTIVE
2. **Container stays running** — OpenClaw gateway runs inside container with correct auth
3. **Slack API** — bot can send DMs via chat.postMessage (verified manually)
4. **Health endpoints** — control plane (3200) and relay (3101) respond
5. **Docker image** — tenant containers start, health/message servers bind, gateway launches
6. **HTTPS** — Caddy reverse proxy with Let's Encrypt cert works
7. **Auth files** — copied into tenant home during provisioning, owned by agent user (uid 1001)
8. **Allowlist** — unauthorized users rejected, authorized users trigger provisioning
9. **OpenClaw agent --local** — verified working inside container (responds "pong" to test message)

## Remaining Bugs 🐛

### Bug 1: Welcome DM never sent to user after tenant becomes ACTIVE

**Symptoms:** After tenant provisions and becomes ACTIVE, the user receives no "Your workspace is ready!" message in Slack.

**Root cause:** Unknown. The relay code has `postSlackDm(slackUserId, 'Your workspace is ready!...')` at line 113 of `apps/slack-relay/dist/app-factory.js`, but it never fires. Possible causes:
- The tenant is already ACTIVE when the relay checks (provisioned by an earlier request)
- `postSlackDm` fails silently (no error logging in the function)
- The `wasAlreadyActive` flag is true because the provisioning completes before the relay polls

**Fix needed:** Add logging to `postSlackDm`. Also ensure the welcome DM fires on first request regardless of timing.

### Bug 2: Messages never forwarded to tenant container

**Symptoms:** After tenant is ACTIVE, subsequent messages from the same user are never forwarded to the container. The `message_queue` table stays empty. Container logs show no "Received message" entries.

**Root cause:** The relay's Step 4 (enqueue) and Step 5 (forward to control plane) either silently fail or are never reached. Likely issues:
- `prisma` client in the relay may fail to connect (no error logging)
- The forward to `${cpBase}/v1/tenants/${tenantId}/message` may fail silently
- The control plane's `/v1/tenants/:tenantId/message` endpoint may reject the request

**Fix needed:** Add error logging throughout the relay's message processing flow. Test the control plane's message endpoint directly.

### Bug 3: `postSlackDm` has no error logging

**Symptoms:** When Slack DM sending fails, there's no log output. The function catches errors silently.

**Fix needed:** Add `log.error({ err }, 'Failed to send Slack DM')` to the catch block in `postSlackDm`.

## Architecture Issues

### Issue 1: Process management on this host

**Problem:** The host machine has zombie node processes from earlier nohup/PM2 sessions that keep grabbing ports 3200 and 3101 before systemd services can start. Even after reboot, PM2's saved dump file (`~/.pm2/dump.pm2`) auto-restores old processes.

**Current mitigation:** `ExecStartPre` in systemd service files kills port holders before starting. PM2 dump files deleted. But orphan processes still appear from the OpenClaw gateway's exec tool running background commands.

**Recommended fix:** Test and verify all services in an **isolated Docker Compose environment** — not on the host where OpenClaw gateway is running. This eliminates interference from the host's own OpenClaw process tree.

### Issue 2: Testing should use Docker Compose

**Problem:** Running control plane, relay, scheduler, and tenant containers on the same host as the OpenClaw gateway causes process interference. Every `exec` command I run creates orphan node processes.

**Recommended approach:**

```yaml
# docker-compose.test.yml
services:
  control-plane:
    build: .
    command: node apps/control-plane/dist/index.js
    ports: ["3200:3200"]
    env_file: .env
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - tenant-data:/data/tenants
      - ./db:/data/claw-orchestrator

  slack-relay:
    build: .
    command: node apps/slack-relay/dist/index.js
    ports: ["3101:3101"]
    env_file: .env
    depends_on: [control-plane]

  scheduler:
    build: .
    command: node apps/scheduler/dist/index.js
    env_file: .env
    depends_on: [control-plane]

volumes:
  tenant-data:
```

Benefits:
- Clean process isolation — no orphans
- Reproducible — `docker compose down && docker compose up`
- Port conflicts impossible
- No interference with host OpenClaw gateway
- Container name resolution works natively (Docker DNS)
- Easy to test welcome DM and message forwarding in isolation

## Verification Checklist

Before declaring the system operational, verify:

- [ ] Send Slack DM → tenant provisions → user receives "Your workspace is ready!" DM
- [ ] Send second Slack DM → message forwarded to container → agent responds → response sent back to user as Slack DM
- [ ] Container stays running for 10+ minutes
- [ ] `openclaw agent --local --agent main --message "test"` works inside container
- [ ] `validate-deployment.sh` passes 19/19

## Files Changed (uncommitted)

- `apps/control-plane/src/docker-run-options.ts` — removed read-only bind mounts, added RELAY_TOKEN env
- `apps/control-plane/src/app-factory.ts` — copy auth files during provisioning, full openclaw.json config
- `apps/slack-relay/src/app-factory.ts` — welcome DM, slack_channel_id stored
- `docker/tenant-image/entrypoint.sh` — runs as root, chowns home, drops to agent
- `docker/tenant-image/Dockerfile` — /usr/local for npm globals, removed USER agent
- `docker/tenant-image/message-server.js` — openclaw agent --local --agent main
- `docker/tenant-image/openclaw.json` — agents.defaults format, gateway.bind=auto
- `deploy/systemd/` — systemd user service files with ExecStartPre port cleanup
- `scripts/install-systemd.sh` — installs and starts systemd services
- `prisma/migrations/` — add slack_channel_id to message_queue
