# Deployment Follow-ups

Bugs found and fixed during the first live EC2 deployment (2026-04-21).

---

## 1. `check_secrets` bash logic bug — `install.sh`

**Symptom:** Script exited after step 1 even when secrets were valid.

**Cause:** `{ [ -z "$secret" ] || [ "$secret" = "placeholder" ]; } && die "..."` — the compound expression returns exit code 1 when secrets *are* set, which `set -euo pipefail` treats as failure.

**Fix:** Rewrote with explicit `if` statements.

---

## 2. Prisma migrate couldn't find the schema — `install.sh`

**Symptom:** `npx prisma migrate deploy` failed with "schema not found".

**Cause:** The script `cd`'d into `apps/control-plane` but the schema lives at repo root.

**Fix:** Pass `--schema "${DEPLOY_DIR}/prisma/schema.prisma"` explicitly.

---

## 3. Prisma migrate couldn't write the database — `install.sh`

**Symptom:** `prisma migrate deploy` failed with permission denied on `/data/claw-orchestrator/`.

**Cause:** The directory is owned by `claw:claw`; the `ubuntu` user can't write to it.

**Fix:** Run as `sudo env DATABASE_URL=... npx prisma migrate deploy ...`, then `chown claw:claw` and `chmod 640` the resulting DB file.

---

## 4. Zod rejected empty string env vars — `schemas.ts`

**Symptom:** Control-plane failed to start: `HOST_DATA_DIR` validation error.

**Cause:** `HOST_DATA_DIR=` in `.env` produces `""`, not `undefined`. `z.string().min(1).optional()` rejects empty strings.

**Fix:** Added `z.preprocess(v => v === '' ? undefined : v, ...)` for `HOST_DATA_DIR` and `CONTAINER_NETWORK` in `packages/shared-config/src/schemas.ts`.

---

## 5. Prisma client not found in pnpm store — `install.sh`

**Symptom:** Control-plane crashed at startup: `@prisma/client did not initialize yet`.

**Cause:** `npx prisma generate` writes the client to `node_modules/.prisma/client` at the workspace root, but each pnpm-isolated package resolves it from `.pnpm/@prisma+client@.../node_modules/.prisma/client`.

**Fix:** After `prisma generate`, symlink all pnpm store `.prisma` directories to the generated client:
```bash
find node_modules/.pnpm -maxdepth 4 -type d -name '.prisma' | while read dir; do
  rm -rf "${dir}/client"
  ln -s "${DEPLOY_DIR}/node_modules/.prisma/client" "${dir}/client"
done
```

---

## 6. Wrong Docker image tag — `.env.example` + DB

**Symptom:** `docker run` failed: `Unable to find image 'claw-tenant:sha-latest' locally`.

**Cause:** `.env.example` had `TENANT_IMAGE=claw-tenant:sha-latest` but `install.sh` builds `claw-tenant:latest`. The `container_images` DB table was also seeded with `sha-latest`.

**Fix:**
- Changed `.env.example` to `TENANT_IMAGE=claw-tenant:latest` (committed).
- Updated the `container_images` DB record directly: `UPDATE container_images SET tag='claw-tenant:latest' WHERE is_default=1`.

---

## 7. Auth files missing from EC2 host

**Symptom:** Tenant container exited immediately with: `ERROR: .credentials.json is missing or empty`.

**Cause:** The control-plane copies `~/.claude/.credentials.json` and `~/.openclaw/agents/main/agent/auth-profiles.json` from the host into each tenant's home directory at provision time. These files didn't exist on the EC2 host.

**Fix:** `scp` both files from the local machine to the EC2 host before running `install.sh`.

`bootstrap.sh` checks for both files and exits with `die "Auth files missing — tenant containers will fail to start."` if either is absent. This is a hard blocker, not advisory.

---

## End-to-End Result

After all fixes: Slack DM → relay → provision → `docker run claw-tenant:latest` → OpenClaw startup (~35s) → message processed → Slack DM reply delivered. Full chain verified working.
