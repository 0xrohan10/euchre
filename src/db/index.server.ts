import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:55437/kitty',
})

export const db = drizzle({ client: pool })
