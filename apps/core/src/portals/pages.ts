import { PORTAL_WAKE_PATH } from '@valet/shared'

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`
}

export function pausedPage(canWake: boolean): string {
  const wake = canWake ? `<form method="post" action="${PORTAL_WAKE_PATH}"><button type="submit">Wake</button></form>` : ''
  return page('Sandbox is paused', `<h1>Sandbox is paused</h1>${wake}`)
}

export function notFoundPage(): string {
  return page('Not found', '<h1>Not found</h1>')
}

export function unavailablePage(port: number, detail: string | null): string {
  const p = detail ? `<p>${escapeHtml(detail)}</p>` : ''
  return page(`Port ${port} is not answering`, `<h1>Nothing is listening on port ${port}</h1>${p}`)
}

export function errorPage(message: string): string {
  return page('Error', `<h1>Error</h1><p>${escapeHtml(message)}</p>`)
}

export function deniedPage(reason: string): string {
  return page('Access denied', `<h1>Access denied</h1><p>${escapeHtml(reason)}</p>`)
}
