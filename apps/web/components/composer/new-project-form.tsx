'use client'

import Link from 'next/link'
import { useEffect, useState, type FormEvent } from 'react'
import type { GitHubRepo, Project, ProjectSource } from '@valet/shared'
import { LockIcon } from 'lucide-react'
import { api, ApiError, errorMessage } from '@/lib/api'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAppData } from '@/components/app/data-provider'

type Props = {
  onCreated: (project: Project) => void
  onCancel?: () => void
  className?: string
}

export function NewProjectForm({ onCreated, onCancel, className }: Props) {
  const { upsertProject } = useAppData()
  const [source, setSource] = useState<ProjectSource>('github')
  const [repo, setRepo] = useState<GitHubRepo | null>(null)
  const [name, setName] = useState('')
  const [defaultBranch, setDefaultBranch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function pickRepo(r: GitHubRepo): void {
    setRepo(r)
    setName(r.fullName.split('/')[1] ?? r.fullName)
    setDefaultBranch(r.defaultBranch)
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const project =
        source === 'github'
          ? await api.projects.create({
              source: 'github',
              repoUrl: repo!.url,
              defaultBranch: defaultBranch || repo!.defaultBranch,
              ...(name.trim() ? { name: name.trim() } : {}),
            })
          : await api.projects.create({ source: 'blank', name: name.trim() })
      upsertProject(project)
      onCreated(project)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const canSubmit = source === 'github' ? repo !== null : name.trim().length > 0

  return (
    <form onSubmit={submit} className={cn('flex flex-col gap-4', className)}>
      <Tabs value={source} onValueChange={(v) => setSource(v as ProjectSource)}>
        <TabsList>
          <TabsTrigger value="github">GitHub repository</TabsTrigger>
          <TabsTrigger value="blank">Blank</TabsTrigger>
        </TabsList>
      </Tabs>

      {source === 'github' ? (
        <>
          <RepoSearch selected={repo} onSelect={pickRepo} />
          {repo && (
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="project-name">Name</Label>
                <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="project-branch">Default branch</Label>
                <Input
                  id="project-branch"
                  value={defaultBranch}
                  onChange={(e) => setDefaultBranch(e.target.value)}
                  className="font-mono"
                />
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-name">Name</Label>
          <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={!canSubmit || busy}>
          Create project
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}

function RepoSearch({ selected, onSelect }: { selected: GitHubRepo | null; onSelect: (r: GitHubRepo) => void }) {
  const [query, setQuery] = useState('')
  const [repos, setRepos] = useState<GitHubRepo[] | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'unconfigured' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      api.credentials
        .githubRepos(query)
        .then((r) => {
          if (cancelled) return
          setRepos(r.repos)
          setState('ready')
        })
        .catch((err: unknown) => {
          if (cancelled) return
          if (err instanceof ApiError && (err.status === 400 || err.status === 409 || err.status === 412)) {
            setState('unconfigured')
          } else {
            setError(errorMessage(err))
            setState('error')
          }
        })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  if (state === 'unconfigured') {
    return (
      <div className="flex items-center gap-3 text-sm">
        <span className="text-muted-foreground">GitHub: Not configured</span>
        <Button asChild size="sm" variant="outline">
          <Link href="/settings">Settings</Link>
        </Button>
      </div>
    )
  }

  return (
    <Command shouldFilter={false} className="rounded-md border">
      <CommandInput placeholder="Search repositories" value={query} onValueChange={setQuery} />
      <CommandList className="max-h-56">
        {state === 'error' && <CommandEmpty>{error}</CommandEmpty>}
        {state === 'ready' && repos?.length === 0 && <CommandEmpty>No repositories</CommandEmpty>}
        {repos?.map((r) => (
          <CommandItem
            key={r.fullName}
            value={r.fullName}
            onSelect={() => onSelect(r)}
            data-checked={selected?.fullName === r.fullName || undefined}
            className="flex items-center gap-2"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{r.fullName}</span>
            {r.private && <LockIcon className="size-3 text-muted-foreground" aria-label="Private" />}
            {r.pushedAt && <span className="text-xs text-muted-foreground">{relativeTime(r.pushedAt)}</span>}
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  )
}
