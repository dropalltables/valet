'use client'

import { useState } from 'react'
import type { PermissionItem } from '@valet/shared'
import { toast } from 'sonner'
import { api, errorMessage } from '@/lib/api'
import { Button } from '@/components/ui/button'

function summary(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return typeof input === 'string' ? input : null
  const o = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'query']) {
    if (typeof o[key] === 'string') return o[key]
  }
  const keys = Object.keys(o)
  return keys.length > 0 ? JSON.stringify(o, null, 2) : null
}

export function PermissionItemView({ threadId, item }: { threadId: string; item: PermissionItem }) {
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null)
  const detail = summary(item.input)

  async function decide(decision: 'allow' | 'deny'): Promise<void> {
    setBusy(decision)
    try {
      await api.threads.permission(threadId, item.id, { decision })
    } catch (err) {
      toast.error(errorMessage(err))
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium">Permission</span>
        <span className="font-mono text-xs text-muted-foreground">{item.toolName}</span>
        <span className="flex-1" />
        {item.decision && (
          <span className="text-xs text-muted-foreground">
            {item.decision === 'allow' ? 'Allowed' : 'Denied'}
            {item.by === 'system' && ' by system'}
          </span>
        )}
      </div>
      {item.description && <p className="text-muted-foreground">{item.description}</p>}
      {detail && (
        <pre className="max-h-48 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap break-words">
          {detail}
        </pre>
      )}
      {!item.decision && (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void decide('allow')} disabled={busy !== null}>
            Allow
          </Button>
          <Button size="sm" variant="outline" onClick={() => void decide('deny')} disabled={busy !== null}>
            Deny
          </Button>
        </div>
      )}
    </div>
  )
}
