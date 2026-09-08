import crypto from 'node:crypto'
import { z } from 'zod'
import { CI_FIX_MAX_ATTEMPTS, type PullRequestState } from '@valet/shared'
import { timingSafeEqualStrings } from '../crypto.js'
import type { PrRow } from '../db/schema.js'

/**
 * GitHub signs the raw request body with the App's webhook secret. The body must be
 * the bytes as delivered: re-serializing the parsed JSON does not reproduce them.
 */
export function verifyWebhookSignature(secret: string, rawBody: string, header: string | undefined): boolean {
  if (!header) return false
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`
  return timingSafeEqualStrings(expected, header)
}

/**
 * What a delivery asks Valet to do, with everything needed to find the thread that
 * owns the pull request: `repo` is `owner/repo`; `branch` is the fallback when a
 * check payload carries no pull request (GitHub omits it for some triggers).
 */
export type WebhookIntent =
  | {
      kind: 'ci-failure'
      repo: string
      prNumber: number | null
      branch: string | null
      /** Head commit the checks ran on; one CI-failure message is sent per commit. */
      sha: string
      check: string
      detailsUrl: string
    }
  | { kind: 'comment'; repo: string; prNumber: number; branch: null; author: string; url: string; body: string }
  | { kind: 'pr-state'; repo: string; prNumber: number; branch: string | null; state: PullRequestState }

const repository = z.object({ full_name: z.string(), html_url: z.string() })
const pullRequests = z.array(z.object({ number: z.number().int() })).default([])

const checkRunEvent = z.object({
  action: z.string(),
  repository,
  check_run: z.object({
    name: z.string(),
    conclusion: z.string().nullable(),
    details_url: z.string().nullable().default(null),
    html_url: z.string().nullable().default(null),
    head_sha: z.string(),
    check_suite: z.object({ head_branch: z.string().nullable().default(null), pull_requests: pullRequests }),
  }),
})

const checkSuiteEvent = z.object({
  action: z.string(),
  repository,
  check_suite: z.object({
    conclusion: z.string().nullable(),
    head_branch: z.string().nullable().default(null),
    head_sha: z.string(),
    app: z.object({ name: z.string() }).nullable().default(null),
    pull_requests: pullRequests,
  }),
})

const workflowRunEvent = z.object({
  action: z.string(),
  repository,
  workflow_run: z.object({
    name: z.string().nullable().default(null),
    conclusion: z.string().nullable(),
    html_url: z.string(),
    head_branch: z.string().nullable().default(null),
    head_sha: z.string(),
    pull_requests: pullRequests,
  }),
})

const pullRequestEvent = z.object({
  action: z.string(),
  repository,
  pull_request: z.object({ number: z.number().int(), merged: z.boolean().default(false), head: z.object({ ref: z.string() }) }),
})

const comment = z.object({
  body: z.string(),
  html_url: z.string(),
  author_association: z.string(),
  user: z.object({ login: z.string() }).nullable().default(null),
})

/**
 * A mentioning comment becomes a prompt for an agent that can push to the branch, so
 * only people GitHub says have write access to the repository may write one. The
 * signature proves GitHub relayed the comment, not who wrote it.
 */
const TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR']

const issueCommentEvent = z.object({
  action: z.string(),
  repository,
  comment,
  issue: z.object({ number: z.number().int(), pull_request: z.unknown().optional() }),
})

const reviewCommentEvent = z.object({
  action: z.string(),
  repository,
  comment,
  pull_request: z.object({ number: z.number().int() }),
})

/** Whole-word `@valet`, case-insensitive. */
const MENTION_RE = /(^|[^\w@])@valet\b/i

/**
 * A delivery Valet acts on, or null for everything else (other actions, successful
 * checks, comments without a mention or from an untrusted author, issue comments that
 * are not on a pull request).
 * Throws only when the payload does not match the event's documented shape.
 */
export function parseWebhookEvent(event: string, payload: unknown): WebhookIntent | null {
  switch (event) {
    case 'check_run': {
      const p = checkRunEvent.parse(payload)
      if (p.action !== 'completed' || p.check_run.conclusion !== 'failure') return null
      return {
        kind: 'ci-failure',
        repo: p.repository.full_name,
        prNumber: p.check_run.check_suite.pull_requests[0]?.number ?? null,
        branch: p.check_run.check_suite.head_branch,
        sha: p.check_run.head_sha,
        check: p.check_run.name,
        detailsUrl: p.check_run.details_url || p.check_run.html_url || checksUrl(p.repository.html_url, p.check_run.head_sha),
      }
    }
    case 'check_suite': {
      const p = checkSuiteEvent.parse(payload)
      if (p.action !== 'completed' || p.check_suite.conclusion !== 'failure') return null
      return {
        kind: 'ci-failure',
        repo: p.repository.full_name,
        prNumber: p.check_suite.pull_requests[0]?.number ?? null,
        branch: p.check_suite.head_branch,
        sha: p.check_suite.head_sha,
        check: p.check_suite.app?.name ?? 'checks',
        detailsUrl: checksUrl(p.repository.html_url, p.check_suite.head_sha),
      }
    }
    case 'workflow_run': {
      const p = workflowRunEvent.parse(payload)
      if (p.action !== 'completed' || p.workflow_run.conclusion !== 'failure') return null
      return {
        kind: 'ci-failure',
        repo: p.repository.full_name,
        prNumber: p.workflow_run.pull_requests[0]?.number ?? null,
        branch: p.workflow_run.head_branch,
        sha: p.workflow_run.head_sha,
        check: p.workflow_run.name ?? 'workflow',
        detailsUrl: p.workflow_run.html_url,
      }
    }
    case 'pull_request': {
      const p = pullRequestEvent.parse(payload)
      const state = prState(p.action, p.pull_request.merged)
      if (!state) return null
      return {
        kind: 'pr-state',
        repo: p.repository.full_name,
        prNumber: p.pull_request.number,
        branch: p.pull_request.head.ref,
        state,
      }
    }
    case 'issue_comment': {
      const p = issueCommentEvent.parse(payload)
      if (p.action !== 'created' || p.issue.pull_request == null || !MENTION_RE.test(p.comment.body)) return null
      return commentIntent(p.repository.full_name, p.issue.number, p.comment)
    }
    case 'pull_request_review_comment': {
      const p = reviewCommentEvent.parse(payload)
      if (p.action !== 'created' || !MENTION_RE.test(p.comment.body)) return null
      return commentIntent(p.repository.full_name, p.pull_request.number, p.comment)
    }
    default:
      return null
  }
}

function commentIntent(repo: string, prNumber: number, c: z.infer<typeof comment>): WebhookIntent | null {
  if (!TRUSTED_ASSOCIATIONS.includes(c.author_association)) return null
  return { kind: 'comment', repo, prNumber, branch: null, author: c.user?.login ?? 'someone', url: c.html_url, body: c.body }
}

/** A reopened pull request is open again; auto-fix must resume with it. */
function prState(action: string, merged: boolean): PullRequestState | null {
  if (action === 'reopened') return 'open'
  if (action !== 'closed') return null
  return merged ? 'merged' : 'closed'
}

function checksUrl(repoUrl: string, sha: string): string {
  return `${repoUrl}/commit/${sha}/checks`
}

export type CiFixDecision =
  | { send: true; attempts: number }
  | { send: false; reason: 'disabled' | 'closed' | 'duplicate' | 'exhausted' }

/**
 * One message per failing head commit, `CI_FIX_MAX_ATTEMPTS` per pull request. The
 * same commit failing several checks (Actions reports one failure as `check_run`,
 * `check_suite`, and `workflow_run`) counts once.
 */
export function ciFixDecision(pr: PrRow, sha: string): CiFixDecision {
  if (!pr.autoFixCi) return { send: false, reason: 'disabled' }
  if (pr.state !== 'open') return { send: false, reason: 'closed' }
  if (pr.ciFixSha === sha) return { send: false, reason: 'duplicate' }
  if (pr.ciFixAttempts >= CI_FIX_MAX_ATTEMPTS) return { send: false, reason: 'exhausted' }
  return { send: true, attempts: pr.ciFixAttempts + 1 }
}

export function ciFixMessage(check: string, detailsUrl: string): string {
  return `CI failed on ${check}: ${detailsUrl}\nFix it and push.`
}

export function commentMessage(intent: Extract<WebhookIntent, { kind: 'comment' }>): string {
  return `${intent.author} commented on #${intent.prNumber}: ${intent.url}\n\n${intent.body}`
}
