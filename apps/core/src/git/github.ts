import { createAppAuth } from '@octokit/auth-app'
import { Octokit } from '@octokit/rest'
import type { GitHubAppInstallation, GitHubBranchesResponse, GitHubRepo } from '@valet/shared'
import { HttpError, badRequest, statusOf } from '../errors.js'
import { errorMessage } from '../logger.js'

export type RepoRef = { owner: string; repo: string }

const GITHUB_RE = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/

export function parseGitHubUrl(url: string): RepoRef | null {
  const m = GITHUB_RE.exec(url.trim())
  if (!m || !m[1] || !m[2]) return null
  return { owner: m[1], repo: m[2] }
}

export function canonicalRepoUrl(ref: RepoRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}`
}

export function cloneUrl(ref: RepoRef): string {
  return `https://x-access-token@github.com/${ref.owner}/${ref.repo}.git`
}

export function requireRepoRef(repoUrl: string | null): RepoRef {
  const ref = repoUrl ? parseGitHubUrl(repoUrl) : null
  if (!ref) throw badRequest('project has no GitHub repository')
  return ref
}

/** Maps octokit failures to API errors with GitHub's message. */
function translate(err: unknown): never {
  const status = statusOf(err)
  const message = errorMessage(err).replace(/ - https:\/\/docs\.github\.com\S*/g, '')
  if (status === 401) throw new HttpError(401, `GitHub rejected the token: ${message}`)
  if (status === 404) throw new HttpError(404, `GitHub: ${message}`)
  if (status === 422) throw new HttpError(409, `GitHub: ${message}`)
  if (status && status >= 400 && status < 600) throw new HttpError(502, `GitHub: ${message}`)
  throw err
}

export class GitHub {
  private readonly octokit: Octokit

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token, userAgent: 'valet' })
  }

  async login(): Promise<string> {
    try {
      const res = await this.octokit.users.getAuthenticated()
      return res.data.login
    } catch (err) {
      translate(err)
    }
  }

  async defaultBranch(ref: RepoRef): Promise<string> {
    try {
      const res = await this.octokit.repos.get({ owner: ref.owner, repo: ref.repo })
      return res.data.default_branch
    } catch (err) {
      translate(err)
    }
  }

  async listRepos(query: string | undefined): Promise<GitHubRepo[]> {
    try {
      const res = await this.octokit.repos.listForAuthenticatedUser({ sort: 'pushed', per_page: 100 })
      const q = query?.trim().toLowerCase()
      return res.data
        .filter((r) => !q || r.full_name.toLowerCase().includes(q))
        .map((r) => ({
          fullName: r.full_name,
          url: r.html_url,
          defaultBranch: r.default_branch,
          private: r.private,
          description: r.description,
          pushedAt: r.pushed_at ?? null,
        }))
    } catch (err) {
      translate(err)
    }
  }

  async listBranches(ref: RepoRef): Promise<GitHubBranchesResponse> {
    try {
      const [branches, repo] = await Promise.all([
        this.octokit.repos.listBranches({ owner: ref.owner, repo: ref.repo, per_page: 100 }),
        this.octokit.repos.get({ owner: ref.owner, repo: ref.repo }),
      ])
      return { branches: branches.data.map((b) => b.name), defaultBranch: repo.data.default_branch }
    } catch (err) {
      translate(err)
    }
  }

  async createPullRequest(
    ref: RepoRef,
    opts: { head: string; base: string; title: string; body: string; draft: boolean },
  ): Promise<{ url: string; number: number }> {
    try {
      const res = await this.octokit.pulls.create({ owner: ref.owner, repo: ref.repo, ...opts })
      return { url: res.data.html_url, number: res.data.number }
    } catch (err) {
      translate(err)
    }
  }

  async pullRequestState(ref: RepoRef, number: number): Promise<'open' | 'merged' | 'closed'> {
    try {
      const res = await this.octokit.pulls.get({ owner: ref.owner, repo: ref.repo, pull_number: number })
      if (res.data.merged) return 'merged'
      return res.data.state === 'closed' ? 'closed' : 'open'
    } catch (err) {
      translate(err)
    }
  }
}

export type GitHubAppCredentials = { appId: number; privateKey: string }

/**
 * Authenticated as the GitHub App itself (a signed JWT), which is what reading
 * installations and minting installation tokens requires. Installation tokens last
 * an hour; `CredentialStore` caches them per repository.
 */
export class GitHubApp {
  private readonly octokit: Octokit

  constructor(creds: GitHubAppCredentials) {
    this.octokit = new Octokit({ authStrategy: createAppAuth, auth: creds, userAgent: 'valet' })
  }

  async installations(): Promise<GitHubAppInstallation[]> {
    try {
      const res = await this.octokit.apps.listInstallations({ per_page: 100 })
      return res.data.map((i) => ({
        id: i.id,
        account: i.account?.login ?? '',
        repositorySelection: i.repository_selection,
      }))
    } catch (err) {
      translate(err)
    }
  }

  /**
   * A token scoped to one repository and the permissions Valet uses, or null when the
   * App is not installed on that repository.
   */
  async installationToken(ref: RepoRef): Promise<{ token: string; expiresAt: string } | null> {
    let installationId: number
    try {
      const res = await this.octokit.apps.getRepoInstallation({ owner: ref.owner, repo: ref.repo })
      installationId = res.data.id
    } catch (err) {
      if (statusOf(err) === 404) return null
      translate(err)
    }
    try {
      const res = await this.octokit.apps.createInstallationAccessToken({
        installation_id: installationId,
        repositories: [ref.repo],
        permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
      })
      return { token: res.data.token, expiresAt: res.data.expires_at }
    } catch (err) {
      translate(err)
    }
  }
}
