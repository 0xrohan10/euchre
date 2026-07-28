import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { betterAuth } from 'better-auth/minimal'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import type { Database } from '../db/index.server'
import * as schema from '../db/schema'

const isProd = process.env.NODE_ENV === 'production'

export function createAuth(database: Database) {
  return betterAuth({
    database: drizzleAdapter(database, { provider: 'pg', schema }),
    emailAndPassword: { enabled: true },
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,
      },
    },
    advanced: {
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProd,
        path: '/',
      },
      useSecureCookies: isProd,
    },
    plugins: [tanstackStartCookies()],
  })
}
