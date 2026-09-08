'use client'

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Health } from '@valet/shared'
import { api, errorMessage } from '@/lib/api'
import { Button } from '@/components/ui/button'

type HealthState = { health: Health | null; error: string | null; refresh: () => Promise<void> }

const Ctx = createContext<HealthState | null>(null)

/** Children render immediately (server-rendered too); a failed check replaces them. */
export function HealthGate({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setHealth(await api.health())
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Core pulls the sandbox image by itself: follow a running pull closely, a missing one loosely.
  const image = health?.sandboxImage ?? null
  const delay = image === null || image.present ? null : image.pulling !== null ? 2_000 : 30_000
  useEffect(() => {
    if (delay === null) return
    const timer = setInterval(() => void refresh(), delay)
    return () => clearInterval(timer)
  }, [delay, refresh])

  const problems: Array<[string, string]> = []
  if (error) problems.push(['Core', error])
  if (health && !health.db.ok) problems.push(['Database', health.db.error ?? 'Not reachable'])
  if (health && !health.docker.ok) problems.push(['Docker', health.docker.error ?? 'Not reachable'])

  if (problems.length > 0) {
    return (
      <div className="flex h-full items-center justify-center p-8" role="alert">
        <div className="flex w-full max-w-md flex-col gap-6">
          <dl className="flex flex-col gap-3 text-sm">
            {problems.map(([name, message]) => (
              <div key={name} className="flex flex-col gap-1">
                <dt className="font-medium">{name}</dt>
                <dd className="break-words font-mono text-xs text-muted-foreground">{message}</dd>
              </div>
            ))}
          </dl>
          <div>
            <Button onClick={() => void refresh()}>Retry</Button>
          </div>
        </div>
      </div>
    )
  }

  return <Ctx.Provider value={{ health, error, refresh }}>{children}</Ctx.Provider>
}

export function useHealth(): HealthState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useHealth outside HealthGate')
  return ctx
}
