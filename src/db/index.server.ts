import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { env } from 'cloudflare:workers'

export function createDb() {
  const connectionString =
    process.env.NODE_ENV === 'production'
      ? env.HYPERDRIVE.connectionString
      : (process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:55437/kitty')

  const pool = new Pool({
    connectionString,
    // A workerd TCP socket belongs to the request that opened it. Reusing an idle pg
    // client in another request causes workerd to cancel that request as hung.
    max: 5,
    maxUses: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 1_000,
    allowExitOnIdle: true,
  })

  pool.on('error', (error) => {
    console.error('Unexpected idle PostgreSQL client error', error)
  })

  return drizzle({ client: pool })
}

export type Database = ReturnType<typeof createDb>
