'use client'

import { useCallback, useMemo, useState } from 'react'
import type { Project, ThreadListItem } from '@valet/shared'
import { toast } from 'sonner'
import { api, errorMessage } from '@/lib/api'
import { useAppData } from '@/components/app/data-provider'

export type ThreadActions = {
  busy: string | null
  /** Git operations need a provisioned, unarchived thread. */
  canGit: boolean
  /** Why Create PR is unavailable, or null when it is. */
  prBlocked: string | null
  prOpen: boolean
  setPrOpen: (open: boolean) => void
  openPr: () => void
  push: () => Promise<void>
  wake: () => void
  pause: () => void
  interrupt: () => void
  archive: () => void
  unarchive: () => void
}

/** Thread-level operations shared by the header and the Changes tab. */
export function useThreadActions(thread: ThreadListItem, project: Project | undefined): ThreadActions {
  const { patchThread } = useAppData()
  const [busy, setBusy] = useState<string | null>(null)
  const [prOpen, setPrOpen] = useState(false)
  const id = thread.id

  const run = useCallback(
    async (name: string, fn: () => Promise<unknown>, done?: string): Promise<void> => {
      setBusy(name)
      try {
        const result = await fn()
        if (result && typeof result === 'object' && 'id' in result && 'status' in result) {
          patchThread(result as ThreadListItem)
        }
        if (done) toast.success(done)
      } catch (err) {
        toast.error(errorMessage(err))
      } finally {
        setBusy(null)
      }
    },
    [patchThread],
  )

  const archived = thread.status === 'archived'
  const canGit = !archived && thread.status !== 'provisioning'
  const prBlocked = project?.source === 'blank' ? 'Blank project' : thread.pr ? 'Pull request exists' : null
  const branch = thread.branch

  return useMemo<ThreadActions>(
    () => ({
      busy,
      canGit,
      prBlocked,
      prOpen,
      setPrOpen,
      openPr: () => setPrOpen(true),
      push: () => run('push', () => api.threads.push(id), `Pushed ${branch}`),
      wake: () => void run('wake', () => api.threads.wake(id)),
      pause: () => void run('pause', () => api.threads.pause(id)),
      interrupt: () => void run('interrupt', () => api.threads.interrupt(id)),
      archive: () => void run('archive', () => api.threads.archive(id)),
      unarchive: () => void run('unarchive', () => api.threads.unarchive(id)),
    }),
    [busy, canGit, prBlocked, prOpen, run, id, branch],
  )
}
