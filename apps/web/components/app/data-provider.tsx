'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { GlobalFrame, Project, Thread, ThreadListItem } from '@valet/shared'
import { api, errorMessage } from '@/lib/api'
import { useGlobalStream } from '@/lib/global-stream'

type AppData = {
  /** Every thread, archived included, newest activity first. */
  threads: ThreadListItem[]
  projects: Project[]
  loaded: boolean
  error: string | null
  refresh: () => Promise<void>
  upsertThread: (thread: ThreadListItem) => void
  /** Merge a bare Thread row (from a thread stream) into the list entry. */
  patchThread: (thread: Thread) => void
  removeThread: (id: string) => void
  upsertProject: (project: Project) => void
  removeProject: (id: string) => void
}

const Ctx = createContext<AppData | null>(null)

function byActivity(a: ThreadListItem, b: ThreadListItem): number {
  return b.lastActivityAt.localeCompare(a.lastActivityAt)
}

/**
 * Ids changed locally (stream frames, responses to our own requests) while a
 * list fetch was in flight. Those updates are newer than the list, so they win
 * over it; without this a slow list response would undo them.
 */
type Inflight = { touched: Set<string>; removed: Set<string> }

function merge<T>(prev: Map<string, T>, fetched: T[], id: (row: T) => string, inflight: Inflight): Map<string, T> {
  const next = new Map<string, T>()
  for (const row of fetched) {
    const key = id(row)
    if (inflight.removed.has(key)) continue
    const cur = prev.get(key)
    next.set(key, cur !== undefined && inflight.touched.has(key) ? cur : row)
  }
  for (const [key, cur] of prev) {
    if (!next.has(key) && inflight.touched.has(key) && !inflight.removed.has(key)) next.set(key, cur)
  }
  return next
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [threads, setThreads] = useState<Map<string, ThreadListItem>>(new Map())
  const [projects, setProjects] = useState<Map<string, Project>>(new Map())
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inflightRef = useRef<Set<Inflight>>(new Set())

  const note = useCallback((kind: keyof Inflight, id: string) => {
    for (const f of inflightRef.current) f[kind].add(id)
  }, [])

  const refresh = useCallback(async () => {
    const inflight: Inflight = { touched: new Set(), removed: new Set() }
    inflightRef.current.add(inflight)
    try {
      const [active, archived, projectList] = await Promise.all([
        api.threads.list(false),
        api.threads.list(true),
        api.projects.list(),
      ])
      setThreads((prev) => merge(prev, [...active.threads, ...archived.threads], (t) => t.id, inflight))
      setProjects((prev) => merge(prev, projectList.projects, (p) => p.id, inflight))
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      inflightRef.current.delete(inflight)
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const upsertThread = useCallback(
    (thread: ThreadListItem) => {
      note('touched', thread.id)
      setThreads((m) => new Map(m).set(thread.id, thread))
    },
    [note],
  )
  const patchThread = useCallback(
    (thread: Thread) => {
      note('touched', thread.id)
      setThreads((m) => {
        const cur = m.get(thread.id)
        if (!cur) return m
        return new Map(m).set(thread.id, { ...cur, ...thread })
      })
    },
    [note],
  )
  const removeThread = useCallback(
    (id: string) => {
      note('removed', id)
      setThreads((m) => {
        if (!m.has(id)) return m
        const next = new Map(m)
        next.delete(id)
        return next
      })
    },
    [note],
  )
  const upsertProject = useCallback(
    (project: Project) => {
      note('touched', project.id)
      setProjects((m) => new Map(m).set(project.id, project))
    },
    [note],
  )
  const removeProject = useCallback(
    (id: string) => {
      note('removed', id)
      setProjects((m) => {
        if (!m.has(id)) return m
        const next = new Map(m)
        next.delete(id)
        return next
      })
    },
    [note],
  )

  useGlobalStream(
    (frame: GlobalFrame) => {
      switch (frame.t) {
        case 'thread':
          upsertThread(frame.thread)
          return
        case 'thread.deleted':
          removeThread(frame.id)
          return
        case 'project':
          upsertProject(frame.project)
          return
        case 'project.deleted':
          removeProject(frame.id)
          return
        default: {
          const _exhaustive: never = frame
          return _exhaustive
        }
      }
    },
    () => void refresh(),
  )

  const value = useMemo<AppData>(
    () => ({
      threads: [...threads.values()].sort(byActivity),
      projects: [...projects.values()].sort((a, b) => a.name.localeCompare(b.name)),
      loaded,
      error,
      refresh,
      upsertThread,
      patchThread,
      removeThread,
      upsertProject,
      removeProject,
    }),
    [threads, projects, loaded, error, refresh, upsertThread, patchThread, removeThread, upsertProject, removeProject],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAppData(): AppData {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAppData outside DataProvider')
  return ctx
}
