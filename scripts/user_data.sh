#!/bin/bash
# =============================================================================
# user_data.sh — EC2 bootstrap script for claw-orchestrator
#
# Paste this into EC2 Launch Wizard → Advanced Details → User data.
# Runs once as root on first boot. Automates Step 2 of the deployment guide.
#
# After this completes (~5 min), SSH in and continue from Step 3:
#   ssh ubuntu@<elastic-ip>
#   cat /var/log/claw-bootstrap.log   # check bootstrap output
#   cat /opt/claw-orchestrator/NEXT_STEPS.md
# =============================================================================

set -euo pipefail
exec > >(tee /var/log/claw-bootstrap.log | logger -t claw-bootstrap) 2>&1

echo "=== claw-orchestrator bootstrap started at $(date) ==="

# -----------------------------------------------------------------------------
# 1. System packages
# -----------------------------------------------------------------------------
echo "--- Installing system packages ---"
apt-get update -y
apt-get install -y \
  ca-certificates \
  curl \
  git \
  jq \
  lsb-release \
  openssl \
  sqlite3 \
  unzip \
  wget

# -----------------------------------------------------------------------------
# 2. Docker Engine (official repo, not docker.io snap)
# -----------------------------------------------------------------------------
echo "--- Installing Docker Engine ---"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Add ubuntu user to docker group (takes effect on next login)
usermod -aG docker ubuntu

systemctl enable docker
systemctl start docker

echo "Docker version: $(docker --version)"
echo "Docker Compose version: $(docker compose version)"

# -----------------------------------------------------------------------------
# 3. Node.js 22 + pnpm
# -----------------------------------------------------------------------------
echo "--- Installing Node.js 22 ---"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
echo "Node version: $(node --version)"
echo "npm version:  $(npm --version)"

echo "--- Installing pnpm ---"
npm install -g pnpm
echo "pnpm version: $(pnpm --version)"

# -----------------------------------------------------------------------------
# 4. Caddy (reverse proxy + automatic TLS)
# -----------------------------------------------------------------------------
echo "--- Installing Caddy ---"
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y
apt-get install -y caddy
echo "Caddy version: $(caddy version)"

# -----------------------------------------------------------------------------
# 5. Mount data EBS volume at /data
#    The second EBS volume is typically /dev/nvme1n1 on Nitro instances.
#    We detect it automatically — first unformatted block device that isn't root.
# -----------------------------------------------------------------------------
echo "--- Mounting data volume ---"

# Find the data device: attached, not mounted, not the root device
ROOT_DEV=$(lsblk -no PKNAME "$(findmnt -n -o SOURCE /)")
DATA_DEV=""
for dev in $(lsblk -ndo NAME,TYPE | awk '$2=="disk"{print $1}'); do
  if [ "$dev" != "$ROOT_DEV" ]; then
    DATA_DEV="/dev/$dev"
    break
  fi
done

if [ -z "$DATA_DEV" ]; then
  echo "WARNING: No secondary block device found. Skipping data volume mount."
  echo "         Attach an EBS volume and mount it manually at /data."
else
  echo "Data device detected: $DATA_DEV"
  # Format only if not already formatted
  if ! blkid "$DATA_DEV" > /dev/null 2>&1; then
    echo "Formatting $DATA_DEV as ext4..."
    mkfs.ext4 -F "$DATA_DEV"
  else
    echo "$DATA_DEV already has a filesystem, skipping format."
  fi

  mkdir -p /data
  mount "$DATA_DEV" /data

  # Persist mount across reboots
  BLKID=$(blkid -s UUID -o value "$DATA_DEV")
  if ! grep -q "$BLKID" /etc/fstab; then
    echo "UUID=$BLKID /data ext4 defaults,nofail 0 2" >> /etc/fstab
  fi

  echo "Data volume mounted at /data"
fi

# Create required directories
mkdir -p /data/tenants
chown -R ubuntu:ubuntu /data

# -----------------------------------------------------------------------------
# 6. Clone the repo
# -----------------------------------------------------------------------------
echo "--- Cloning claw-orchestrator ---"
if [ -d /opt/claw-orchestrator ]; then
  echo "Repo already exists, pulling latest..."
  git -C /opt/claw-orchestrator pull
else
  git clone https://github.com/iamsteveng/claw-orchestrator.git /opt/claw-orchestrator
fi
chown -R ubuntu:ubuntu /opt/claw-orchestrator

# -----------------------------------------------------------------------------
# 7. Create auth file directories (to be populated manually)
# -----------------------------------------------------------------------------
echo "--- Creating auth directories ---"
mkdir -p /home/ubuntu/.openclaw/agents/main/agent
mkdir -p /home/ubuntu/.claude
chown -R ubuntu:ubuntu /home/ubuntu/.openclaw /home/ubuntu/.claude

# -----------------------------------------------------------------------------
# 8. Placeholder Caddyfile (to be updated with real IP/domain)
# -----------------------------------------------------------------------------
echo "--- Writing placeholder Caddyfile ---"
# Caddy will be configured properly in Step 8 of the deployment guide
# after the Elastic IP is known. For now, disable the default site.
cat > /etc/caddy/Caddyfile <<'CADDY'
# Placeholder — replace <elastic-ip> with your actual Elastic IP
# then run: sudo systemctl reload caddy
#
# <elastic-ip>.nip.io {
#     reverse_proxy localhost:13101
# }
CADDY
systemctl reload caddy || true

# -----------------------------------------------------------------------------
# 9. Systemd unit for Docker Compose stack (disabled until .env is ready)
# -----------------------------------------------------------------------------
echo "--- Installing claw-orchestrator systemd unit (disabled) ---"
cat > /etc/systemd/system/claw-orchestrator.service <<'UNIT'
[Unit]
Description=Claw Orchestrator (Docker Compose)
After=docker.service network-online.target
Requires=docker.service

[Service]
User=ubuntu
Group=ubuntu
WorkingDirectory=/opt/claw-orchestrator
ExecStartPre=docker compose -f docker/docker-compose.test.yml pull --quiet || true
ExecStart=docker compose -f docker/docker-compose.test.yml up
ExecStop=docker compose -f docker/docker-compose.test.yml down
Restart=on-failure
RestartSec=15
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
# Do NOT enable yet — needs .env and auth files first
echo "Systemd unit installed but NOT enabled. Enable after completing setup."

# -----------------------------------------------------------------------------
# 10. Write NEXT_STEPS.md for easy reference after SSH login
# -----------------------------------------------------------------------------
cat > /opt/claw-orchestrator/NEXT_STEPS.md <<'STEPS'
# Next Steps — Complete the deployment

Bootstrap is done. SSH in and follow these steps:

## Step 3: Create .env
```bash
cp /opt/claw-orchestrator/.env.example /opt/claw-orchestrator/.env
nano /opt/claw-orchestrator/.env
```
Fill in: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, and verify DATA_DIR/DATABASE_URL.

## Step 4: Copy auth files from your local machine
From your LOCAL machine:
```bash
scp ~/.openclaw/agents/main/agent/auth-profiles.json ubuntu@<elastic-ip>:~/.openclaw/agents/main/agent/
scp ~/.claude/.credentials.json ubuntu@<elastic-ip>:~/.claude/
```
Verify:
```bash
test -f ~/.openclaw/agents/main/agent/auth-profiles.json && echo "✓ OpenClaw auth OK"
test -f ~/.claude/.credentials.json && echo "✓ Claude Code auth OK"
```

## Step 5: Build the tenant Docker image
```bash
cd /opt/claw-orchestrator
docker build \
  --build-arg IMAGE_TAG=sha-$(git rev-parse --short HEAD) \
  -t claw-tenant:latest \
  docker/tenant-image/
```

## Step 6: Start the stack
```bash
cd /opt/claw-orchestrator
docker compose -f docker/docker-compose.test.yml up -d --build
docker compose -f docker/docker-compose.test.yml ps
curl http://localhost:13200/health
curl http://localhost:13101/health
```

## Step 7: Run DB migrations + add yourself to allowlist
```bash
cd /opt/claw-orchestrator
DATABASE_URL=file:/data/tenants/orchestrator.db npx prisma migrate deploy
curl -s -X POST http://localhost:13200/v1/admin/allowlist \
  -H "content-type: application/json" \
  -d '{"slack_team_id":"T_YOUR_TEAM","slack_user_id":"U_YOUR_USER","added_by":"admin"}'
```

## Step 8: Configure Caddy
```bash
sudo nano /etc/caddy/Caddyfile
```
Replace contents with:
```
<elastic-ip>.nip.io {
    reverse_proxy localhost:13101
}
```
```bash
sudo systemctl reload caddy
curl https://<elastic-ip>.nip.io/health
```

## Step 9: Update Slack app webhook URL
Set Request URL to: https://<elastic-ip>.nip.io/slack/events

## Step 10: Enable auto-start on reboot
```bash
sudo systemctl enable claw-orchestrator
```

## Useful commands
```bash
docker compose -f /opt/claw-orchestrator/docker/docker-compose.test.yml ps
docker logs claw-cp-test -f
docker logs claw-relay-test -f
cat /var/log/claw-bootstrap.log   # bootstrap log
```
STEPS

chown ubuntu:ubuntu /opt/claw-orchestrator/NEXT_STEPS.md

# -----------------------------------------------------------------------------
echo ""
echo "=== Bootstrap complete at $(date) ==="
echo ""
echo "SSH in and run: cat /opt/claw-orchestrator/NEXT_STEPS.md"
echo ""
