import { NextResponse, type NextRequest } from 'next/server'
import { parsePortalHost, portalDomain } from '@valet/shared'

/** Sent to core so it knows the host the browser used (Next rewrites Host to core's). */
const PORTAL_HOST_HEADER = 'x-valet-portal-host'

/**
 * Three jobs, all needing request-time environment:
 *
 * 1. Requests whose Host is a portal hostname under the portal domain (derived from
 *    VALET_PORTAL_DOMAIN and VALET_BASE_URL exactly as core does) are rewritten,
 *    whole, to core's `/portal/<thread>/<port><path>`. Every path, method, and
 *    WebSocket upgrade belongs to the app in the sandbox, including `/_next/*` and `/api/*`.
 * 2. `/api/*` is rewritten to core. A `next.config` rewrite would bake
 *    VALET_CORE_URL into the build; a proxy rewrite reads it per request, and
 *    Next proxies WebSocket upgrades through the same path.
 * 3. When VALET_PASSWORD is set, page requests without a `valet_session` cookie
 *    go to /login, except `/s/<token>` (an unlisted thread link, which carries its
 *    own credential). Core verifies the cookie; this only checks presence.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl
  const core = process.env.VALET_CORE_URL ?? 'http://localhost:8080'

  const host = request.headers.get('host')?.toLowerCase() ?? ''
  const portal = parsePortalHost(host, portalDomain({ VALET_PORTAL_DOMAIN: process.env.VALET_PORTAL_DOMAIN, VALET_BASE_URL: process.env.VALET_BASE_URL }))
  if (portal) {
    const headers = new Headers(request.headers)
    headers.set(PORTAL_HOST_HEADER, host)
    return NextResponse.rewrite(new URL(`/portal/${portal.threadId}/${portal.port}${pathname}${search}`, core), { request: { headers } })
  }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return NextResponse.rewrite(new URL(pathname + search, core))
  }

  if (pathname.startsWith('/_next/') || pathname === '/favicon.ico') return NextResponse.next()

  if (process.env.VALET_PASSWORD && pathname !== '/login' && !pathname.startsWith('/s/') && !request.cookies.has('valet_session')) {
    const login = new URL('/login', request.url)
    if (pathname !== '/') login.searchParams.set('next', pathname + search)
    return NextResponse.redirect(login)
  }

  return NextResponse.next()
}

// Everything, including `/_next/*`: on a portal host those paths belong to the app inside the sandbox.
export const config = {
  matcher: ['/(.*)'],
}
