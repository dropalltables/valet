'use client'

import { useEffect, useState, type FormEvent } from 'react'
import type { Thread, ThreadListItem } from '@valet/shared'
import { toast } from 'sonner'
import { api, errorMessage } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

type Props = {
  thread: ThreadListItem
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (thread: Thread) => void
}

export function CreatePrDialog({ thread, open, onOpenChange, onCreated }: Props) {
  const [title, setTitle] = useState(thread.title)
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setTitle(thread.title)
      setError(null)
    }
  }, [open, thread.title])

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const updated = await api.threads.createPr(thread.id, { title: title.trim() || thread.title, body, draft })
      onCreated(updated)
      onOpenChange(false)
      if (updated.pr) toast.success(`Pull request #${updated.pr.number}`)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Create pull request</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pr-title">Title</Label>
            <Input id="pr-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pr-body">Body</Label>
            <Textarea id="pr-body" value={body} onChange={(e) => setBody(e.target.value)} rows={6} />
          </div>
          <div className="flex items-center gap-2">
            <Switch id="pr-draft" checked={draft} onCheckedChange={setDraft} />
            <Label htmlFor="pr-draft">Draft</Label>
          </div>
          <p className="font-mono text-xs text-muted-foreground">
            {thread.branch} into {thread.baseBranch}
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Create pull request
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
