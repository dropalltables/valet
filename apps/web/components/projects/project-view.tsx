'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState, type FormEvent } from 'react'
import useSWR from 'swr'
import type { Project, ProjectEnvVar } from '@valet/shared'
import { toast } from 'sonner'
import { api, ApiError, errorMessage } from '@/lib/api'
import { relativeTime, repoSlug } from '@/lib/format'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { StatusDot } from '@/components/app/status'
import { useAppData } from '@/components/app/data-provider'

export function ProjectView({ id }: { id: string }) {
  const { projects, threads, loaded, upsertProject } = useAppData()
  const [missing, setMissing] = useState<string | null>(null)
  const project = projects.find((p) => p.id === id)

  useEffect(() => {
    if (project || !loaded) return
    api.projects
      .get(id)
      .then(upsertProject)
      .catch((err: unknown) =>
        setMissing(err instanceof ApiError && err.status === 404 ? 'Not found' : errorMessage(err)),
      )
  }, [id, project, loaded, upsertProject])

  if (!project) {
    if (!missing) return null
    return <div className="flex h-full items-center justify-center text-sm">{missing}</div>
  }

  const projectThreads = threads.filter((t) => t.projectId === id)

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-10 px-6 py-8">
        <Details project={project} />
        <EnvVars projectId={project.id} />
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">Threads</h2>
          {projectThreads.length === 0 ? (
            <Button asChild size="sm" variant="outline" className="self-start">
              <Link href="/">New thread</Link>
            </Button>
          ) : (
            <ul className="flex flex-col">
              {projectThreads.map((t) => (
                <li key={t.id}>
                  <Link
                    href={`/threads/${t.id}`}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/60"
                  >
                    <StatusDot status={t.status} />
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                    <span className="font-mono text-xs text-muted-foreground">{t.branch}</span>
                    <span className="text-xs text-muted-foreground">{relativeTime(t.lastActivityAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        <DeleteProject project={project} threadCount={projectThreads.length} />
      </div>
    </div>
  )
}

function Details({ project }: { project: Project }) {
  const { upsertProject } = useAppData()
  const [name, setName] = useState(project.name)
  const [branch, setBranch] = useState(project.defaultBranch)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setName(project.name)
    setBranch(project.defaultBranch)
  }, [project.name, project.defaultBranch])

  const dirty = name.trim() !== project.name || branch.trim() !== project.defaultBranch

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!dirty) return
    setBusy(true)
    try {
      upsertProject(await api.projects.update(project.id, { name: name.trim(), defaultBranch: branch.trim() }))
      toast.success('Saved')
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name">Name</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="branch">Default branch</Label>
          <Input id="branch" value={branch} onChange={(e) => setBranch(e.target.value)} className="font-mono" />
        </div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Repository</dt>
        <dd className="font-mono text-xs">
          {project.repoUrl ? (
            <a href={project.repoUrl} target="_blank" rel="noreferrer" className="hover:underline">
              {repoSlug(project.repoUrl)}
            </a>
          ) : (
            'Blank'
          )}
        </dd>
        <dt className="text-muted-foreground">Setup script</dt>
        <dd className="font-mono text-xs">
          {project.hasSetupScript === null ? 'Unknown until first clone' : project.hasSetupScript ? '.valet/setup' : 'None'}
        </dd>
        <dt className="text-muted-foreground">Created</dt>
        <dd>{relativeTime(project.createdAt)}</dd>
      </dl>
      <div>
        <Button type="submit" size="sm" disabled={!dirty || busy || !name.trim() || !branch.trim()}>
          Save
        </Button>
      </div>
    </form>
  )
}

type EnvDraft = { name: string; value: string; kind: 'plain' | 'secret'; original: string | null }

function EnvVars({ projectId }: { projectId: string }) {
  const { data, error, mutate } = useSWR(['env', projectId], () => api.projects.env.get(projectId))
  const [draft, setDraft] = useState<EnvDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const vars = data?.vars ?? []

  async function put(next: Array<{ name: string; value?: string; kind: 'plain' | 'secret' }>): Promise<void> {
    setBusy(true)
    try {
      await mutate(await api.projects.env.put(projectId, { vars: next }), { revalidate: false })
      setDraft(null)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  function keep(v: ProjectEnvVar): { name: string; kind: 'plain' | 'secret' } {
    return { name: v.name, kind: v.kind }
  }

  // Core keeps an omitted value by name, so a renamed variable must carry its value.
  const keepsValue = draft !== null && draft.original !== null && draft.name.trim() === draft.original
  const needsValue = draft !== null && !keepsValue

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!draft) return
    const name = draft.name.trim()
    const others = vars.filter((v) => v.name !== draft.original && v.name !== name).map(keep)
    const entry =
      keepsValue && draft.value === '' ? { name, kind: draft.kind } : { name, value: draft.value, kind: draft.kind }
    await put([...others, entry])
  }

  async function remove(name: string): Promise<void> {
    await put(vars.filter((v) => v.name !== name).map(keep))
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Environment variables</h2>
        <Button size="sm" variant="outline" onClick={() => setDraft({ name: '', value: '', kind: 'plain', original: null })}>
          Add variable
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(error)}
        </p>
      )}
      {vars.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Value</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {vars.map((v) => (
              <TableRow key={v.name}>
                <TableCell className="font-mono text-xs">{v.name}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{v.kind === 'secret' ? 'Secret' : 'Plain'}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{v.maskedValue}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setDraft({ name: v.name, value: '', kind: v.kind, original: v.name })}
                  >
                    Edit
                  </Button>
                  <Button size="xs" variant="ghost" disabled={busy} onClick={() => void remove(v.name)}>
                    Delete
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent>
          {draft && (
            <form onSubmit={save} className="flex flex-col gap-4">
              <DialogHeader>
                <DialogTitle>{draft.original ? 'Edit variable' : 'Add variable'}</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="env-name">Name</Label>
                <Input
                  id="env-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })}
                  className="font-mono"
                  autoFocus={!draft.original}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="env-value">Value</Label>
                <Input
                  id="env-value"
                  type={draft.kind === 'secret' ? 'password' : 'text'}
                  value={draft.value}
                  onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                  placeholder={keepsValue ? 'Unchanged' : undefined}
                  required={needsValue}
                  className="font-mono"
                  autoFocus={!!draft.original}
                />
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="env-secret"
                  checked={draft.kind === 'secret'}
                  onCheckedChange={(c) => setDraft({ ...draft, kind: c ? 'secret' : 'plain' })}
                />
                <Label htmlFor="env-secret">Secret</Label>
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy || !draft.name.trim() || (needsValue && !draft.value)}>
                  Save
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}

function DeleteProject({ project, threadCount }: { project: Project; threadCount: number }) {
  const router = useRouter()
  const { removeProject } = useAppData()
  const [open, setOpen] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function remove(force: boolean): Promise<void> {
    setBusy(true)
    try {
      await api.projects.remove(project.id, force)
      removeProject(project.id)
      router.push('/projects')
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict(err.message)
      else toast.error(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
          Delete project
        </Button>
      </div>
      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) setConflict(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {project.name}</AlertDialogTitle>
            <AlertDialogDescription>
              {project.repoUrl ? repoSlug(project.repoUrl) : 'Blank'}
              {threadCount > 0 && ` · ${threadCount} ${threadCount === 1 ? 'thread' : 'threads'}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {conflict && (
            <p role="alert" className="text-sm text-destructive">
              {conflict}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {conflict ? (
              <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void remove(true)}>
                Delete with threads
              </AlertDialogAction>
            ) : (
              <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void remove(false)}>
                Delete
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
