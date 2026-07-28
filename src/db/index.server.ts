import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:55437/kitty',
  max: 5,
  maxUses: 1,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 1_000,
})

export const db = drizzle({ client: pool })
