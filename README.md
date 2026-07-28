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
- `bun run cf:build`: apply prod migrations (production branch only) then build — used by Workers Builds
- `bun run test`: run the Vitest suite
- `bun run lint`: run Oxlint
- `docker compose up -d`: start the development PostgreSQL database
- `docker compose down`: stop the development PostgreSQL database
- `bun run db:generate -- --name=<name>`: generate a migration from the Drizzle schema
- `bun run db:migrate`: apply pending migrations

## Cloudflare Workers

The app is configured for Cloudflare Workers through the Cloudflare Vite plugin and Wrangler. Production needs a publicly reachable PostgreSQL database.

### One-time secrets

**Runtime** (Worker process — Settings → Variables & Secrets, or CLI):

```bash
bunx wrangler secret put DATABASE_URL
bunx wrangler secret put BETTER_AUTH_SECRET
bunx wrangler secret put BETTER_AUTH_URL
```

`BETTER_AUTH_URL` must be the final public origin, for example `https://euchre.<account>.workers.dev` or the custom domain.

**Build** (Workers Builds only — Settings → Build → Variables and secrets):

| Name           | Value                                        |
| -------------- | -------------------------------------------- |
| `DATABASE_URL` | Same direct Postgres URL used for migrations |

Build secrets are not available at runtime. Runtime secrets are not available during the build. Set `DATABASE_URL` in both places.

### Automatic migrations on git push

Workers Builds does not read build commands from `wrangler.jsonc`. Configure them in the dashboard: **Workers & Pages → euchre → Settings → Build**.

| Setting            | Value                                    |
| ------------------ | ---------------------------------------- |
| **Build command**  | `bun run cf:build`                       |
| **Deploy command** | `bunx wrangler deploy` (default is fine) |

`cf:build` runs `drizzle-kit migrate` then `vite build`. On non-production branch builds it skips migrate so previews never touch prod. Override the production branch name with build variable `CF_PRODUCTION_BRANCH` if it is not `main`.

Flow on each push to the production branch:

1. Build secret `DATABASE_URL` is injected
2. Pending SQL under `src/db/migrations/` is applied
3. App is built and deployed

If migrate fails, the build fails and the new Worker is not deployed.

### Manual deploy

```bash
DATABASE_URL='postgresql://...' bun run db:migrate
bun run deploy
bunx wrangler tail
```

For production traffic, put PostgreSQL behind [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/) and use its connection string binding in `src/db/index.server.ts`. Keep the direct `DATABASE_URL` for migrations (build secret + local) even if the Worker uses Hyperdrive at runtime.

## Architecture

- Better Auth owns users, password credentials, sessions, and authentication cookies.
- Drizzle owns the PostgreSQL schema and generated migration history.
- Effect's `GameService` owns transactional game workflows and typed failures.
- `game.ts` remains a deterministic, framework-independent rules engine.
- TanStack server functions authenticate and validate commands before invoking Effect.
- SSE streams seat-redacted room views; opponent hands and the kitty never leave the server.
