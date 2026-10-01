import { SERVICE_WAKE_PATH } from '@valet/shared'

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// The same palette as the review widget, so a page core serves on a service host looks
// like the rest of Valet rather than the browser's defaults.
const STYLE = [
  ':root { color-scheme: light dark; }',
  'body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 2rem; box-sizing: border-box;',
  '  font: 14px/1.5 system-ui, -apple-system, sans-serif; background: #ffffff; color: #171717; }',
  'main { display: flex; flex-direction: column; gap: 1rem; width: 100%; max-width: 20rem; }',
  'h1 { margin: 0; font-size: 1.125rem; font-weight: 500; }',
  'p { margin: 0; color: #737373; overflow-wrap: anywhere; }',
  'form { display: flex; }',
  'button { font: inherit; padding: 0.375rem 0.75rem; border: 1px solid #d4d4d4; border-radius: 6px; background: #ffffff; color: inherit; cursor: pointer; }',
  'button:hover { background: #f5f5f5; }',
  '@media (prefers-color-scheme: dark) {',
  '  body { background: #0a0a0a; color: #ededed; }',
  '  p { color: #a1a1a1; }',
  '  button { border-color: #3f3f3f; background: #1c1c1c; }',
  '  button:hover { background: #262626; }',
  '}',
].join('\n')

function page(title: string, body: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`
  )
}

export function pausedPage(canWake: boolean): string {
  const wake = canWake ? `<form method="post" action="${SERVICE_WAKE_PATH}"><button type="submit">Wake</button></form>` : ''
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
