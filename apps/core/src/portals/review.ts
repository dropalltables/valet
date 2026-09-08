import { randomBytes } from 'node:crypto'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import { PORTAL_REVIEW_PATH, PORTAL_REVIEW_SCRIPT_PATH, type PortalReviewRequest } from '@valet/shared'

/**
 * The review widget: injected into an owner's HTML pages inside a portal, it sends
 * a comment about one element back to `/__valet/review` on the same host.
 *
 * It runs inside someone else's app, so it touches nothing outside its own shadow
 * root: the hover outline is a fixed-position box of its own rather than a style on
 * the page's elements, and the host element carries no styles the page can inherit.
 */
export const REVIEW_WIDGET_JS = `(function () {
  var TAG = 'valet-review'
  if (document.querySelector(TAG)) return

  var STYLE = [
    // A page rule matching the host, such as body > * { position: relative }, is an outer normal
    // declaration and beats a plain :host one; only !important here keeps the widget in its corner.
    ':host { position: fixed !important; right: 12px !important; bottom: 12px !important; left: auto !important; top: auto !important;',
    '  z-index: 2147483647 !important; display: flex !important; margin: 0 !important; width: auto !important; max-width: none !important;',
    '  flex-direction: column; align-items: flex-end; gap: 8px;',
    '  font: 13px/1.45 system-ui, -apple-system, sans-serif; color: #171717; }',
    'button { font: inherit; padding: 3px 8px; border: 1px solid #d4d4d4; border-radius: 6px; background: #ffffff; color: inherit; cursor: pointer; }',
    'button[disabled] { opacity: 0.5; cursor: default; }',
    '.panel { display: none; flex-direction: column; gap: 6px; width: 260px; padding: 8px; border: 1px solid #d4d4d4; border-radius: 6px; background: #ffffff; }',
    '.selector { font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #737373; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    'textarea { font: inherit; min-height: 56px; padding: 5px 6px; resize: vertical; border: 1px solid #d4d4d4; border-radius: 6px; background: transparent; color: inherit; }',
    '.status { font-size: 12px; color: #737373; }',
    '.status:empty { display: none; }',
    '.actions { display: flex; justify-content: flex-end; gap: 6px; }',
    '.outline { display: none; position: fixed; pointer-events: none; outline: 1px solid #737373; }',
    ':host([data-mode="selecting"]) .outline, :host([data-mode="composing"]) .outline { display: block; }',
    ':host([data-mode="composing"]) .panel { display: flex; }',
    ':host([data-mode="composing"]) .trigger { display: none; }',
    '@media (prefers-color-scheme: dark) {',
    '  :host { color: #ededed; }',
    '  button, .panel { border-color: #3f3f3f; background: #1c1c1c; }',
    '  textarea { border-color: #3f3f3f; }',
    '  .selector, .status { color: #a1a1a1; }',
    '  .outline { outline-color: #a1a1a1; }',
    '}',
  ].join('\\n')

  function selectorFor(el) {
    if (el.id) return '#' + CSS.escape(el.id)
    if (el === document.body) return 'body'
    var parts = []
    var node = el
    while (node && node.nodeType === 1 && node !== document.body) {
      if (node.id) {
        parts.unshift('#' + CSS.escape(node.id))
        break
      }
      var part = node.tagName.toLowerCase()
      var parent = node.parentElement
      var twins = parent ? Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName }) : []
      if (twins.length > 1) part += ':nth-of-type(' + (twins.indexOf(node) + 1) + ')'
      parts.unshift(part)
      node = parent
    }
    return parts.join(' > ')
  }

  function excerptOf(el) {
    return (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 200)
  }

  var host = document.createElement(TAG)
  var root = host.attachShadow({ mode: 'open' })
  // A constructed sheet rather than a <style> element, which a page's style-src would block.
  var sheet = new CSSStyleSheet()
  sheet.replaceSync(STYLE)
  root.adoptedStyleSheets = [sheet]
  var outline = document.createElement('div')
  outline.className = 'outline'
  var trigger = document.createElement('button')
  trigger.className = 'trigger'
  trigger.textContent = 'Comment'
  var panel = document.createElement('div')
  panel.className = 'panel'
  var selectorLine = document.createElement('div')
  selectorLine.className = 'selector'
  var note = document.createElement('textarea')
  note.setAttribute('aria-label', 'Note')
  note.placeholder = 'Note'
  var status = document.createElement('div')
  status.className = 'status'
  var actions = document.createElement('div')
  actions.className = 'actions'
  var cancel = document.createElement('button')
  cancel.textContent = 'Cancel'
  var send = document.createElement('button')
  send.textContent = 'Send'
  actions.appendChild(cancel)
  actions.appendChild(send)
  panel.appendChild(selectorLine)
  panel.appendChild(note)
  panel.appendChild(status)
  panel.appendChild(actions)
  root.appendChild(outline)
  root.appendChild(panel)
  root.appendChild(trigger)
  document.body.appendChild(host)

  var target = null

  function mode() {
    return host.getAttribute('data-mode') || 'idle'
  }

  function place(el) {
    var r = el.getBoundingClientRect()
    outline.style.left = r.left + 'px'
    outline.style.top = r.top + 'px'
    outline.style.width = r.width + 'px'
    outline.style.height = r.height + 'px'
  }

  function under(event) {
    var el = document.elementFromPoint(event.clientX, event.clientY)
    return !el || el === host ? null : el
  }

  function onMove(event) {
    var el = under(event)
    if (el) place(el)
  }

  function onClick(event) {
    var el = under(event)
    if (!el) return
    event.preventDefault()
    event.stopPropagation()
    compose(el)
  }

  function swallow(event) {
    if (under(event)) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  function onKey(event) {
    if (event.key === 'Escape') idle()
  }

  function reposition() {
    if (target) place(target)
  }

  /** Pointer events are taken over while an element is being picked, and only then. */
  function pick(on) {
    var fn = on ? document.addEventListener : document.removeEventListener
    fn.call(document, 'mousemove', onMove, true)
    fn.call(document, 'mousedown', swallow, true)
    fn.call(document, 'mouseup', swallow, true)
    fn.call(document, 'click', onClick, true)
  }

  function idle() {
    pick(false)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('scroll', reposition, true)
    window.removeEventListener('resize', reposition)
    target = null
    note.value = ''
    status.textContent = ''
    send.disabled = false
    trigger.textContent = 'Comment'
    host.setAttribute('data-mode', 'idle')
  }

  function select() {
    trigger.textContent = 'Cancel'
    host.setAttribute('data-mode', 'selecting')
    pick(true)
    document.addEventListener('keydown', onKey, true)
  }

  function compose(el) {
    pick(false)
    target = el
    place(el)
    selectorLine.textContent = selectorFor(el)
    host.setAttribute('data-mode', 'composing')
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    note.focus()
  }

  function submit() {
    var text = note.value.trim()
    if (!text || !target) return
    send.disabled = true
    status.textContent = ''
    fetch('${PORTAL_REVIEW_PATH}', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selector: selectorFor(target), path: location.pathname + location.search, excerpt: excerptOf(target), note: text }),
    })
      .then(
        function (res) {
          if (res.redirected || res.status === 403) return 'Signed out'
          return res.ok ? null : 'Comment failed (' + res.status + ')'
        },
        // A rejected fetch is the page's own connect-src or a dropped connection; the browser's
        // wording ('Failed to fetch') says nothing useful in someone else's page.
        function () {
          return 'Comment failed'
        },
      )
      .then(function (failure) {
        if (failure !== null) {
          status.textContent = failure
          send.disabled = false
          return
        }
        idle()
        trigger.textContent = 'Sent'
        setTimeout(function () {
          if (mode() === 'idle') trigger.textContent = 'Comment'
        }, 2000)
      })
  }

  trigger.addEventListener('click', function () {
    if (mode() === 'selecting') idle()
    else select()
  })
  cancel.addEventListener('click', idle)
  send.addEventListener('click', submit)
  note.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit()
  })
  idle()
})()
`

/** HTML larger than this is served untouched: injection has to buffer the whole body. */
export const MAX_HTML_BYTES = 8 * 1024 * 1024
const CSP_HEADERS = ['content-security-policy', 'content-security-policy-report-only']

/** Whether the response is an HTML document this proxy can decode and rewrite as text. */
export function isInjectableHtml(headers: Headers): boolean {
  const type = headers.get('content-type')
  if (!type || !/^\s*text\/html\s*(;|$)/i.test(type)) return false
  const charset = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(type)?.[1]?.trim().toLowerCase()
  return charset === undefined || charset === 'utf-8' || charset === 'utf8' || charset === 'us-ascii'
}

/** The body as text, or null when it is compressed with something unknown or too large. */
export function decodeHtml(body: Buffer, encoding: string | null): string | null {
  if (body.byteLength > MAX_HTML_BYTES) return null
  const coding = encoding?.trim().toLowerCase() ?? 'identity'
  // The cap applies to what comes out too: a few compressed megabytes inflate to gigabytes.
  const limit = { maxOutputLength: MAX_HTML_BYTES }
  try {
    if (coding === 'identity' || coding === '') return body.toString('utf8')
    if (coding === 'gzip' || coding === 'x-gzip') return gunzipSync(body, limit).toString('utf8')
    if (coding === 'br') return brotliDecompressSync(body, limit).toString('utf8')
    if (coding === 'deflate') return inflateSync(body, limit).toString('utf8')
  } catch {
    return null
  }
  return null
}

/** `<script src>` is governed by the first of these the policy names; the rest do not apply. */
const SCRIPT_DIRECTIVES = [/^script-src-elem(\s|$)/i, /^script-src(\s|$)/i, /^default-src(\s|$)/i]

/** One policy with the nonce added to the directive governing scripts, or null when none does. */
function policyWithNonce(policy: string, nonce: string): string | null {
  const directives = policy
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d)
  let governing = -1
  for (const re of SCRIPT_DIRECTIVES) {
    governing = directives.findIndex((d) => re.test(d))
    if (governing !== -1) break
  }
  if (governing === -1) return null
  const tokens = (directives[governing] ?? '').split(/\s+/)
  // `'none'` next to another source is a no-op; replacing it says the same thing plainly.
  const sources = tokens.slice(1).filter((t) => t.toLowerCase() !== "'none'")
  directives[governing] = [tokens[0], ...sources, `'nonce-${nonce}'`].join(' ')
  return directives.join('; ')
}

/**
 * A nonce the injected script tag can carry, or null when the response's CSP (if
 * any) does not restrict scripts. A nonce satisfies the script directive whatever its
 * source list says, so it is the only edit needed, and it is made to that directive alone.
 * Every policy has to allow the script, so each one in a header gets the nonce.
 */
export function allowInjectedScript(headers: Headers): string | null {
  const nonce = randomBytes(16).toString('base64')
  let used = false
  for (const name of CSP_HEADERS) {
    const csp = headers.get(name)
    if (csp === null) continue
    // A header can carry several policies, and `Headers.get` joins repeated headers the same way.
    let edited = false
    const policies = csp.split(',').map((policy) => {
      const next = policyWithNonce(policy, nonce)
      if (next === null) return policy.trim()
      edited = true
      return next
    })
    if (!edited) continue
    headers.set(name, policies.join(', '))
    used = true
  }
  return used ? nonce : null
}

/** The widget's script tag before the last `</body>`, or at the end when there is none. */
export function injectWidget(html: string, nonce: string | null): string {
  const tag = `<script src="${PORTAL_REVIEW_SCRIPT_PATH}" defer${nonce === null ? '' : ` nonce="${nonce}"`}></script>`
  // Matched on the original string: `toLowerCase()` can change its length (`\u0130` becomes two chars).
  let close = -1
  for (const match of html.matchAll(/<\/body/gi)) close = match.index
  return close === -1 ? html + tag : html.slice(0, close) + tag + html.slice(close)
}

/** The comment as it reads in the transcript. */
export function reviewMessage(req: PortalReviewRequest): string {
  const head = `Portal comment on ${req.path} (${req.selector}): ${req.note}`
  return req.excerpt ? `${head}\n\nElement text: ${req.excerpt}` : head
}
