import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { test } from 'node:test'
import { CI_FIX_MAX_ATTEMPTS } from '@valet/shared'
import type { PrRow } from '../src/db/schema.js'
import { ciFixDecision, ciFixMessage, commentMessage, parseWebhookEvent, verifyWebhookSignature } from '../src/git/webhook.js'

const repository = { full_name: 'acme/widgets', html_url: 'https://github.com/acme/widgets' }
const HEAD_SHA = '9f2a1c4b0e6d8a3f5c7b2e1d0a9f8e7d6c5b4a39'

function checkRun(conclusion: string, extra: Record<string, unknown> = {}): unknown {
  return {
    action: 'completed',
    repository,
    check_run: {
      name: 'build',
      conclusion,
      details_url: 'https://github.com/acme/widgets/runs/1',
      html_url: 'https://github.com/acme/widgets/runs/1',
      head_sha: HEAD_SHA,
      check_suite: { head_branch: 'valet/fix-login-a1b2', pull_requests: [{ number: 42 }] },
      ...extra,
    },
  }
}

function issueComment(body: string, onPullRequest = true, association = 'OWNER'): unknown {
  return {
    action: 'created',
    repository,
    comment: {
      body,
      html_url: 'https://github.com/acme/widgets/pull/42#issuecomment-1',
      author_association: association,
      user: { login: 'octocat' },
    },
    issue: { number: 42, ...(onPullRequest ? { pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/42' } } : {}) },
  }
}

const pr = (over: Partial<PrRow> = {}): PrRow => ({
  url: 'https://github.com/acme/widgets/pull/42',
  number: 42,
  state: 'open',
  autoFixCi: true,
  ciFixAttempts: 0,
  ciFixSha: null,
  ...over,
})

test('webhook signature verification', () => {
  const secret = 'a-webhook-secret'
  const body = JSON.stringify({ action: 'completed' })
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`
  assert.equal(verifyWebhookSignature(secret, body, signature), true)
  assert.equal(verifyWebhookSignature(secret, body, undefined), false)
  assert.equal(verifyWebhookSignature(secret, body, 'sha256=deadbeef'), false)
  assert.equal(verifyWebhookSignature(secret, `${body} `, signature), false)
  assert.equal(verifyWebhookSignature('other-secret', body, signature), false)
})

test('check_run failures become ci-failure intents', () => {
  const intent = parseWebhookEvent('check_run', checkRun('failure'))
  assert.deepEqual(intent, {
    kind: 'ci-failure',
    repo: 'acme/widgets',
    prNumber: 42,
    branch: 'valet/fix-login-a1b2',
    sha: HEAD_SHA,
    check: 'build',
    detailsUrl: 'https://github.com/acme/widgets/runs/1',
  })
  assert.equal(parseWebhookEvent('check_run', checkRun('success')), null)
  assert.equal(parseWebhookEvent('check_run', checkRun('cancelled')), null)
  assert.equal(parseWebhookEvent('check_run', checkRun('skipped')), null)
  assert.equal(parseWebhookEvent('check_run', { ...(checkRun('failure') as object), action: 'created' }), null)
})

test('check payloads without a pull request fall back to the branch', () => {
  const intent = parseWebhookEvent('check_run', checkRun('failure', { check_suite: { head_branch: 'valet/fix-login-a1b2', pull_requests: [] } }))
  assert.equal(intent?.kind, 'ci-failure')
  assert.equal(intent?.prNumber, null)
  assert.equal(intent?.branch, 'valet/fix-login-a1b2')
})

test('check_suite and workflow_run failures name the check and link the run', () => {
  const suite = parseWebhookEvent('check_suite', {
    action: 'completed',
    repository,
    check_suite: {
      conclusion: 'failure',
      head_branch: 'valet/fix-login-a1b2',
      head_sha: HEAD_SHA,
      app: { name: 'GitHub Actions' },
      pull_requests: [{ number: 42 }],
    },
  })
  assert.deepEqual(suite, {
    kind: 'ci-failure',
    repo: 'acme/widgets',
    prNumber: 42,
    branch: 'valet/fix-login-a1b2',
    sha: HEAD_SHA,
    check: 'GitHub Actions',
    detailsUrl: `https://github.com/acme/widgets/commit/${HEAD_SHA}/checks`,
  })

  const run = parseWebhookEvent('workflow_run', {
    action: 'completed',
    repository,
    workflow_run: {
      name: 'CI',
      conclusion: 'failure',
      html_url: 'https://github.com/acme/widgets/actions/runs/7',
      head_branch: 'valet/fix-login-a1b2',
      head_sha: HEAD_SHA,
      pull_requests: [{ number: 42 }],
    },
  })
  assert.equal(run?.kind, 'ci-failure')
  assert.equal(run?.check, 'CI')
  assert.equal(run?.detailsUrl, 'https://github.com/acme/widgets/actions/runs/7')
})

test('comments are forwarded only when they mention valet', () => {
  const intent = parseWebhookEvent('issue_comment', issueComment('Hey @valet please rebase this'))
  assert.deepEqual(intent, {
    kind: 'comment',
    repo: 'acme/widgets',
    prNumber: 42,
    branch: null,
    author: 'octocat',
    url: 'https://github.com/acme/widgets/pull/42#issuecomment-1',
    body: 'Hey @valet please rebase this',
  })
  assert.equal(parseWebhookEvent('issue_comment', issueComment('looks good to me')), null)
  assert.equal(parseWebhookEvent('issue_comment', issueComment('mail valet@example.com')), null)
  assert.equal(parseWebhookEvent('issue_comment', issueComment('@valetteer is someone else')), null)
  // An issue that is not a pull request has no thread to message.
  assert.equal(parseWebhookEvent('issue_comment', issueComment('@valet fix it', false)), null)

  const review = parseWebhookEvent('pull_request_review_comment', {
    action: 'created',
    repository,
    comment: {
      body: '@Valet this needs a null check',
      html_url: 'https://github.com/acme/widgets/pull/42#discussion_r1',
      author_association: 'COLLABORATOR',
      user: { login: 'octocat' },
    },
    pull_request: { number: 42 },
  })
  assert.equal(review?.kind, 'comment')
  assert.equal(
    review && review.kind === 'comment' ? commentMessage(review) : '',
    'octocat commented on #42: https://github.com/acme/widgets/pull/42#discussion_r1\n\n@Valet this needs a null check',
  )
})

test('comments from outside the repository are not forwarded', () => {
  // The signature proves GitHub relayed the comment, not that its author is trusted.
  for (const association of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN']) {
    assert.equal(parseWebhookEvent('issue_comment', issueComment('@valet run the tests', true, association)), null, association)
  }
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    const intent = parseWebhookEvent('issue_comment', issueComment('@valet run the tests', true, association))
    assert.equal(intent?.kind, 'comment', association)
  }
  assert.throws(() => parseWebhookEvent('issue_comment', { action: 'created', repository, comment: { body: '@valet go', html_url: 'u' }, issue: { number: 42, pull_request: {} } }))
})

test('pull request events carry the state the thread should take', () => {
  const pullRequest = (action: string, merged: boolean): unknown => ({
    action,
    repository,
    pull_request: { number: 42, merged, head: { ref: 'valet/fix-login-a1b2' } },
  })

  assert.deepEqual(parseWebhookEvent('pull_request', pullRequest('closed', true)), {
    kind: 'pr-state',
    repo: 'acme/widgets',
    prNumber: 42,
    branch: 'valet/fix-login-a1b2',
    state: 'merged',
  })
  const closed = parseWebhookEvent('pull_request', pullRequest('closed', false))
  assert.equal(closed?.kind === 'pr-state' ? closed.state : null, 'closed')
  // Auto-fix must resume on a reopened pull request instead of dropping its failures.
  const reopened = parseWebhookEvent('pull_request', pullRequest('reopened', false))
  assert.equal(reopened?.kind === 'pr-state' ? reopened.state : null, 'open')

  assert.equal(parseWebhookEvent('pull_request', pullRequest('synchronize', false)), null)
})

test('unhandled events are ignored', () => {
  assert.equal(parseWebhookEvent('push', { repository }), null)
  assert.equal(parseWebhookEvent('ping', { zen: 'Non-blocking is better than blocking.' }), null)
})

test('malformed payloads are rejected rather than guessed at', () => {
  assert.throws(() => parseWebhookEvent('check_run', { action: 'completed', repository }))
})

test('one ci-fix attempt per head commit, up to the limit', () => {
  assert.deepEqual(ciFixDecision(pr(), HEAD_SHA), { send: true, attempts: 1 })
  assert.deepEqual(ciFixDecision(pr({ autoFixCi: false }), HEAD_SHA), { send: false, reason: 'disabled' })
  assert.deepEqual(ciFixDecision(pr({ state: 'merged' }), HEAD_SHA), { send: false, reason: 'closed' })
  // The same failure arrives as check_run, check_suite, and workflow_run.
  assert.deepEqual(ciFixDecision(pr({ ciFixAttempts: 1, ciFixSha: HEAD_SHA }), HEAD_SHA), { send: false, reason: 'duplicate' })
  assert.deepEqual(ciFixDecision(pr({ ciFixAttempts: 1, ciFixSha: HEAD_SHA }), 'b'.repeat(40)), { send: true, attempts: 2 })
  assert.deepEqual(ciFixDecision(pr({ ciFixAttempts: CI_FIX_MAX_ATTEMPTS, ciFixSha: HEAD_SHA }), 'b'.repeat(40)), {
    send: false,
    reason: 'exhausted',
  })
})

test('ci-fix message', () => {
  assert.equal(ciFixMessage('build', 'https://github.com/acme/widgets/runs/1'), 'CI failed on build: https://github.com/acme/widgets/runs/1\nFix it and push.')
})
