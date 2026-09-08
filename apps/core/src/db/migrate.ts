import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type { Db } from './index.js'

/**
 * `drizzle/` sits next to `dist/` in the image and next to `src/` in development;
 * both resolve to `<apps/core>/drizzle` from this file's location.
 */
export function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, here.endsWith(path.join('src', 'db')) ? '../../drizzle' : '../drizzle')
}

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: migrationsFolder() })
}
