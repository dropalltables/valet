import { NextResponse, type NextRequest } from 'next/server'

/**
 * Two jobs, both needing request-time environment:
 *
 * 1. `/api/*` is rewritten to core. A `next.config` rewrite would bake
 *    VALET_CORE_URL into the build; a proxy rewrite reads it per request, and
 *    Next proxies WebSocket upgrades through the same path.
 * 2. When VALET_PASSWORD is set, page requests without a `valet_session` cookie
 *    go to /login. Core verifies the cookie; this only checks presence.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    const core = process.env.VALET_CORE_URL ?? 'http://localhost:8080'
    return NextResponse.rewrite(new URL(pathname + search, core))
  }

  if (process.env.VALET_PASSWORD && pathname !== '/login' && !request.cookies.has('valet_session')) {
    const login = new URL('/login', request.url)
    if (pathname !== '/') login.searchParams.set('next', pathname + search)
    return NextResponse.redirect(login)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
