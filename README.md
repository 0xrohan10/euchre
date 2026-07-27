# Euchs.xyz

A server-authoritative, four-player Euchre game built with TanStack Start, Effect v4, Better Auth, Drizzle ORM, and PostgreSQL.

## Local setup

1. Copy `.env.example` to `.env` and set `BETTER_AUTH_SECRET`.
2. Start PostgreSQL with `docker compose up -d` (exposed on port `55437`).
3. Apply migrations with `bun run db:migrate`.
4. Start the application with `bun run dev`.

`BETTER_AUTH_SECRET` must contain at least 32 high-entropy characters. Keep authentication and the frontend on the same origin in production.

## Commands

- `bun run dev`: start the development server
- `bun run build`: build client and server bundles
- `bun run test`: run the Vitest suite
- `bun run lint`: run Oxlint
- `docker compose up -d`: start the development PostgreSQL database
- `docker compose down`: stop the development PostgreSQL database
- `bun run db:generate -- --name=<name>`: generate a migration from the Drizzle schema
- `bun run db:migrate`: apply pending migrations

## Architecture

- Better Auth owns users, password credentials, sessions, and authentication cookies.
- Drizzle owns the PostgreSQL schema and generated migration history.
- Effect's `GameService` owns transactional game workflows and typed failures.
- `game.ts` remains a deterministic, framework-independent rules engine.
- TanStack server functions authenticate and validate commands before invoking Effect.
- SSE streams seat-redacted room views; opponent hands and the kitty never leave the server.
