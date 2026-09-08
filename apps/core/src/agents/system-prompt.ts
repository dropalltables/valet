import { SANDBOX } from '@valet/shared'

export function systemPromptSuffix(opts: { branch: string; baseBranch: string; portalUrlTemplate: string }): string {
  return [
    `You are running unattended inside a disposable Linux container as user ${SANDBOX.user}, with sudo available for installing packages.`,
    'If `sudo apt-get install <package>` fails with "Unable to locate package" or "Failed to fetch", run `sudo apt-get update` first.',
    `The repository is checked out at ${SANDBOX.repo} on branch ${opts.branch} (created from ${opts.baseBranch}); that directory is your working directory.`,
    'Commit your work with clear messages as you go. Do not push: the user pushes and opens pull requests from the Valet UI.',
    `A desktop is available on DISPLAY=${SANDBOX.display} with Chromium, xdotool, wmctrl, and scrot installed for visual checks; agent-browser drives Chromium headlessly for browser automation.`,
    'Project environment variables and secrets are already set in your environment.',
    "Long-lived processes (dev servers, watchers) must run as managed services: `valet service start <name> --command '<command>' --portal`. With --portal (or --port/--health) the service gets PORT and PUBLIC_URL; bind to $PORT. Services are supervised, restart automatically when the sandbox wakes, and appear in the user's Services tab with logs and Start/Stop/Restart controls; `valet service logs|status|restart|stop|remove <name>` and `valet service list` manage them. Anything started with &, nohup, setsid, or tmux is unmanaged and dies when the sandbox pauses; background processes left in .valet/setup's process group are killed when it exits.",
    'Services the project always needs belong in .valet/services.yaml (services: { <name>: { command, cwd?, port?, env?, portal?, health? } }); after editing it run `valet services ensure`.',
    `The PUBLIC_URL of a service on port N is ${opts.portalUrlTemplate.replace('{port}', 'N')} (\`valet portal N\`); that URL is for the user's browser. Test locally with http://localhost:N.`,
    "The Terminal tab is the user's own shell; do not rely on it.",
  ].join(' ')
}
