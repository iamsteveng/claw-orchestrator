
# Deployment Divergence Register

This register documents every intentional behavioral difference between the **local Docker Compose test environment** (`bash scripts/local-test.sh`) and the **production systemd deployment** (`deploy/scripts/install.sh` / `update.sh`).

**Principle:** Every behavioral difference must appear here with a compensating test or explicit deferral. If you observe a difference not in this register, either eliminate it (preferred) or add a row with a compensating test.

**How to update:** When adding a new intentional divergence, add a row to the table below. Include: what differs, the production value, the compose value, and how the local test compensates.

---

## Divergence Table

| # | Dimension | Production | Local Compose | Status | Compensating Test / Notes |
|---|-----------|-----------|---------------|--------|--------------------------|
| 1 | DB file path | `/data/claw-orchestrator/db.sqlite` | `/data/tenants/orchestrator.db` (container-internal) | Intentional — different dirs by design | Schema hash parity verified by `PRAGMA journal_mode` check; validator uses `env-validator` with host-side path |
| 2 | DB file ownership | `claw:claw 640` — writable only by root/claw | `root:root 644` — created by container root | Intentional — compose has no `claw` user | `local-test.sh` runs `docker exec claw-cp-test chmod o+w /data/tenants/orchestrator.db` after CP health before invoking validator |
| 3 | DB world-write workaround | N/A — production services run as root and write directly | `local-test.sh` uses `docker exec chmod o+w` so host `ubuntu` can write allowlist entries via `sqlite3` | Intentional compose-only quirk | Test passes in both modes; workaround is documented in `scripts/local-test.sh` comments |
| 4 | HTTPS / Caddy reverse proxy | Caddy on port 443 with Let's Encrypt TLS | No HTTPS — compose exposes plain HTTP only | Deferred — Phase 6 | Section 1 HTTPS check skipped via `SKIP_HTTPS_CHECK=1`; `local-test.sh` always sets this; deferred to future Phase 6 (`--profile caddy`) |
| 5 | Host ports | CP: 3200, relay: 3101 | CP: 13200, relay: 13101 | Intentional — coexists with production on same host | `local-test.sh` exports `CP_URL=http://localhost:13200` and `RELAY_LOCAL_URL=http://localhost:13101/...` before invoking `validate-deployment.sh` |
| 6 | `CONTAINER_NETWORK` during Phase 2 rollout | `bridge` (existing ACTIVE tenants) → `claw-net` (new tenants, via passive reconcile) | `claw-orchestrator-test_default` (compose-named network with DNS) | Transitional — self-correcting within 48h idle-stop window | CP startup logs WARN for any ACTIVE tenant still on bridge; IP selection prefers named-network IP before fallback |
| 7 | Systemd restart semantics | `Restart=on-failure` per service (CP, relay, scheduler restart independently) | `restart: unless-stopped` (compose restarts on any exit including clean exit 0) | Accepted — no production bugs attributed to this difference | No compensating test; documented here; watch for clean-exit bugs if they emerge |
| 8 | Process entry point | `node apps/control-plane/dist/index.js` run by systemd directly on host | Services run inside Docker containers via multi-stage Dockerfile | Intentional substrate difference | Compose images built from the same source; `pnpm -r build` produces identical dist output |

---

## Gaps Closed (no longer in this register)

These divergences were identified and eliminated:

| Dimension | Closed In | How |
|-----------|-----------|-----|
| Dual auth-copy code paths (`provision.ts` vs `app-factory.ts`) | Phase 1 | Single `copyAuthFiles()` helper with `process.env.HOME ?? os.homedir()` |
| Non-deterministic IP selection in health-poll | Phase 2.2 | Prefer `networks[CONTAINER_NETWORK]?.IPAddress` before fallback |
| Migration failure silently swallowed | Phase 3 | `process.exit(1)` on migrate failure; `CLAW_MIGRATION_LENIENT=1` escape hatch |
| `user_data.sh` wrong `DATABASE_URL` | Phase 3b | Corrected to production path |

---

*Last updated: 2026-04-23. Maintained by the team working on deployment convergence (plan: `.omc/plans/deployment-convergence.md`).*
