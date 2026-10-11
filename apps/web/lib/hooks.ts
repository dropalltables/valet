'use client'

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { UsageRange } from '@valet/shared'
import useSWR from 'swr'
import { api } from './api'

/** Current time, re-read every `intervalMs`, so relative timestamps stay current. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

export function useAgents() {
  return useSWR('agents', () => api.agents.list(), { revalidateOnFocus: false })
}

export function useSettings() {
  return useSWR('settings', () => api.settings.get(), { revalidateOnFocus: false })
}

export function useNotifications() {
  return useSWR('notifications', () => api.notifications.get(), { revalidateOnFocus: false })
}

export function useSnapshots() {
  return useSWR('snapshots', () => api.snapshots())
}

export function useMcpServers() {
  return useSWR('mcp-servers', () => api.mcpServers.list(), { revalidateOnFocus: false })
}

export function useAccounts() {
  return useSWR('accounts', () => api.accounts.list(), { revalidateOnFocus: false })
}

export function useCredentials() {
  return useSWR('credentials', () => api.credentials.list())
}

export function useGitHubApp() {
  return useSWR('github-app', () => api.credentials.githubApp(), { revalidateOnFocus: false })
}

export function useBranches(repoUrl: string | null) {
  const slug = repoUrl ? repoUrl.replace(/^https?:\/\/github\.com\//, '').split('/') : null
  const owner = slug?.[0]
  const repo = slug?.[1]
  return useSWR(owner && repo ? ['branches', owner, repo] : null, () => api.credentials.githubBranches(owner!, repo!), {
    revalidateOnFocus: false,
  })
}

export function useUsage(range: UsageRange) {
  return useSWR(['usage', range], () => api.usage(range), { revalidateOnFocus: false })
}

/** The sidebar collapses into a drawer and the thread panes stack below this width (Tailwind's `md`). */
export const MOBILE_QUERY = '(max-width: 767.98px)'

/**
 * Whether `query` matches. Server-rendered as false and re-read on hydration,
 * so a page that depends on it is laid out for a wide screen first.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  )
}

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY)
}
