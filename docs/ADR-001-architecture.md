# ADR-001: MAXIM v1 Architecture

## Status

Accepted (2026-02-28). The workspace inventory below reflects the current project;
the [project description](project-description.md) owns runtime topology.

## Decision

Use npm workspaces monorepo:

- `apps/api`: NestJS + Fastify + Prisma + BullMQ
- `apps/miniapp`: React + Vite
- `apps/admin`: closed owner Safety Desk, React + Vite
- `apps/eraser`: independent bot with its own Postgres/Redis
- `packages/contracts`: shared zod schemas and TS types

## Rationale

- Shared contracts reduce API/UI drift.
- Queue-based processing improves resilience for webhook spikes.
- Postgres + Redis satisfy consistency + throughput requirements.

## Consequences

- Production uses Docker Compose. Local native checks can also use disposable PostgreSQL/Redis
  without a Docker daemon through the [test-store wrapper](development/agent-local-environment.md).
- Requires strict secret handling in `.env` and GitHub Secrets.
