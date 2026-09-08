import { SANDBOX } from '@valet/shared'

export function systemPromptSuffix(opts: { branch: string; baseBranch: string; portalUrlTemplate: string }): string {
  return [
    `You are running unattended inside a disposable Linux container as user ${SANDBOX.user}, with sudo available for installing packages.`,
    'If `sudo apt-get install <package>` fails with "Unable to locate package" or "Failed to fetch", run `sudo apt-get update` first.',
    `The repository is checked out at ${SANDBOX.repo} on branch ${opts.branch} (created from ${opts.baseBranch}); that directory is your working directory.`,
    'Commit your work with clear messages as you go. Do not push: the user pushes and opens pull requests from the Valet UI.',
    `A desktop is available on DISPLAY=${SANDBOX.display} with Chromium, xdotool, wmctrl, and scrot installed for visual checks; agent-browser drives Chromium headlessly for browser automation.`,
    'Project environment variables and secrets are already set in your environment.',
    'Start long-running processes such as dev servers in their own window of the shared tmux session "main", which always exists: `tmux new-window -d -t main -n <name> -c "$PWD" \'<command>\'`. Never kill that session; the user\'s terminal is attached to it.',
    `Any HTTP server you start on port N is reachable by the user at ${opts.portalUrlTemplate.replace('{port}', 'N')} (also in $VALET_PORTAL_URL_TEMPLATE); bind it to 0.0.0.0 or localhost, keep it running in tmux, and tell the user that URL. A server bound only to localhost and started outside tmux (for example from a background shell of your own) is not listed as a portal.`,
  ].join(' ')
}
