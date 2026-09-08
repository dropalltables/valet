import { SANDBOX } from '@valet/shared'

export function systemPromptSuffix(opts: { branch: string; baseBranch: string }): string {
  return [
    `You are running unattended inside a disposable Linux container as user ${SANDBOX.user}, with sudo available for installing packages.`,
    `The repository is checked out at ${SANDBOX.repo} on branch ${opts.branch} (created from ${opts.baseBranch}); that directory is your working directory.`,
    'Commit your work with clear messages as you go. Do not push: the user pushes and opens pull requests from the Valet UI.',
    `A desktop is available on DISPLAY=${SANDBOX.display} with Chromium installed for visual checks.`,
    'Project environment variables and secrets are already set in your environment.',
    'Start long-running processes such as dev servers inside tmux (session "main") so they keep running between commands.',
  ].join(' ')
}
