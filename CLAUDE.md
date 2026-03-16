# Claw Orchestrator — Agent Instructions

## Before You Do Anything

Read `SPEC.md` in this directory. It is the single source of truth for this project — architecture, data models, API contracts, service design, infrastructure, and acceptance criteria. Do not start implementing without reading it first.

## Project Summary

Claw Orchestrator is a multi-tenant control plane that gives each Slack user their own isolated OpenClaw agent runtime in a Docker container on a single Linux host.

Three services: `slack-relay`, `control-plane`, `scheduler`.
Stack: Node.js 22 + TypeScript, Fastify, Prisma + SQLite, Docker (via execa).

## Key Conventions

- Monorepo: `apps/` for services, `packages/` for shared libs
- All DB access via Prisma — no raw SQL except for advisory locks
- Docker CLI calls go through `packages/docker-client` (execa wrapper)
- Config validation via Zod at startup — fail fast if env vars missing
- Pino for structured logging — always include `tenantId` in log context
- API versioned under `/v1/`

## Working on a Story

1. Read `SPEC.md` for full context on the story you're implementing
2. Check `progress.txt` (Codebase Patterns section) for prior learnings
3. Implement the story
4. Run typechecks: `npm run typecheck` (or per-package equivalent)
5. Commit with: `feat: [Story ID] - [Story Title]`
