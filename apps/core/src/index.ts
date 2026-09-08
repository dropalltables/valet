import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import pkg from '../package.json' with { type: 'json' }
import { Auth } from './auth.js'
import { loadConfig } from './config.js'
import { DeviceLoginManager } from './credentials/device-login.js'
import { CredentialStore } from './credentials/store.js'
import { Cipher } from './crypto.js'
import { createDb } from './db/index.js'
import { runMigrations } from './db/migrate.js'
import { DockerClient } from './docker/client.js'
import { EventLog } from './events/log.js'
import { GitHub, parseGitHubUrl } from './git/github.js'
import { errorMessage, logger } from './logger.js'
import { McpServerStore } from './mcp/store.js'
import { ModelCatalog, STALE_AFTER_MS } from './models/catalog.js'
import { NotificationService } from './notifications/service.js'
import { PortalAuth } from './portals/auth.js'
import { PortalGateway } from './portals/gateway.js'
import { PortalUrls } from './portals/urls.js'
import { ProjectService } from './projects/service.js'
import { SnapshotStore } from './projects/snapshots.js'
import { createApp } from './routes/index.js'
import { SettingsService } from './settings.js'
import { ThreadService } from './threads/service.js'
import { ThreadShares } from './threads/share.js'
import { UsageService } from './usage/service.js'
import { attachWebSockets } from './ws/index.js'

const log = logger('core')

async function main(): Promise<void> {
  const cfg = loadConfig()
  const cipher = new Cipher(cfg.VALET_SECRET_KEY)
  const { db, pool } = createDb(cfg.DATABASE_URL)
  await runMigrations(db)
  log.info('database ready')

  const docker = new DockerClient(cfg)
  await docker.ping().then(
    async () => log.info('docker ready', await docker.environment()),
    (err: unknown) => log.warn('docker is not reachable; sandboxes will fail until it is', { message: errorMessage(err) }),
  )

  const events = new EventLog(db)
  const credentials = new CredentialStore(db, cipher)
  const settings = new SettingsService(db, cfg, cipher)
  const snapshots = new SnapshotStore(db, cfg, docker, events)
  const projects = new ProjectService(db, cipher, cfg, events, snapshots, async (repoUrl) => {
    const ref = parseGitHubUrl(repoUrl)
    if (!ref) return null
    const token = await credentials.githubTokenFor(ref)
    if (!token) return null
    return new GitHub(token).defaultBranch(ref).catch(() => null)
  })
  const portalUrls = new PortalUrls(cfg)
  const mcp = new McpServerStore(db, cipher)
  const threads = new ThreadService({ db, cfg, cipher, docker, events, projects, snapshots, credentials, settings, portalUrls, mcp })
  const shares = new ThreadShares(cfg, cipher, threads)
  const catalog = new ModelCatalog(db, docker, credentials)
  const deviceLogins = new DeviceLoginManager(db, docker, credentials, () => void catalog.refresh('codex'))
  const usage = new UsageService(db)
  const auth = new Auth(cfg, cipher)
  const portalAuth = new PortalAuth(cipher, auth.enabled, db)
  await portalAuth.load()
  auth.onLogout(() => portalAuth.revokeOwners())
  const portals = new PortalGateway({ cfg, urls: portalUrls, portalAuth, auth, threads })
  const notifications = new NotificationService({ db, cfg, cipher, events, settings })
  notifications.watch()

  const app = createApp({ version: pkg.version, cfg, db, auth, docker, events, credentials, deviceLogins, catalog, settings, notifications, projects, snapshots, threads, shares, portals, usage, mcp })
  const server = serve({ fetch: app.fetch, port: cfg.PORT, hostname: '0.0.0.0' }, (info) => {
    log.info('listening', { port: info.port, auth: auth.enabled, portalDomain: portalUrls.domain })
  }) as Server
  attachWebSockets(server, { auth, events, threads, shares, portals })

  await threads.reconcile().catch((err: unknown) => log.error('reconcile failed', { err }))
  await deviceLogins.reconcile().catch((err: unknown) => log.error('device login reconcile failed', { err }))
  threads.startSweeper()
  docker.startImageWatcher()
  snapshots.startSweeper()
  await catalog.refreshStale(STALE_AFTER_MS).catch((err: unknown) => log.error('model catalog check failed', { err }))

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('shutting down', { signal })
    const timer = setTimeout(() => process.exit(1), 10_000)
    timer.unref()
    server.close()
    docker.shutdown()
    snapshots.stopSweeper()
    void threads
      .shutdown()
      .then(() => pool.end())
      .finally(() => process.exit(0))
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  process.stderr.write(`core failed to start: ${errorMessage(err)}\n`)
  process.exit(1)
})
