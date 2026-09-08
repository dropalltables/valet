'use client'

import { useState, type FormEvent } from 'react'
import { MCP_SERVER_NAME_RE, type McpServer, type McpServerInput, type McpServerScope, type McpServerType, type McpValue } from '@valet/shared'
import { toast } from 'sonner'
import { api, errorMessage } from '@/lib/api'
import { useMcpServers, useSettings } from '@/lib/hooks'
import { useAppData } from '@/components/app/data-provider'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'

/** A header or environment entry being edited; an empty `value` keeps the stored one. */
type ValueDraft = { name: string; value: string; stored: boolean }

type Draft = {
  id: string | null
  name: string
  type: McpServerType
  url: string
  command: string
  args: string
  values: ValueDraft[]
  scope: McpServerScope
  projectIds: string[]
  enabled: boolean
}

function toDraft(server: McpServer): Draft {
  const values = (server.type === 'http' ? server.headers : server.env).map((v: McpValue) => ({
    name: v.name,
    value: '',
    stored: true,
  }))
  return {
    id: server.id,
    name: server.name,
    type: server.type,
    url: server.type === 'http' ? server.url : '',
    command: server.type === 'stdio' ? server.command : '',
    args: server.type === 'stdio' ? server.args.join('\n') : '',
    values,
    scope: server.scope,
    projectIds: server.projectIds,
    enabled: server.enabled,
  }
}

const emptyDraft: Draft = {
  id: null,
  name: '',
  type: 'http',
  url: '',
  command: '',
  args: '',
  values: [],
  scope: 'all',
  projectIds: [],
  enabled: true,
}

/** A stored value is kept by sending its name without a value. */
function toInput(draft: Draft): McpServerInput {
  const entries = draft.values
    .filter((v) => v.name.trim() !== '')
    .map((v) => (v.value === '' && v.stored ? { name: v.name.trim() } : { name: v.name.trim(), value: v.value }))
  const common = {
    name: draft.name.trim(),
    enabled: draft.enabled,
    scope: draft.scope,
    projectIds: draft.scope === 'selected' ? draft.projectIds : [],
  }
  if (draft.type === 'http') return { ...common, type: 'http', url: draft.url.trim(), headers: entries }
  return {
    ...common,
    type: 'stdio',
    command: draft.command.trim(),
    args: draft.args.split('\n').map((a) => a.trim()).filter((a) => a !== ''),
    env: entries,
  }
}

function target(server: McpServer): string {
  return server.type === 'http' ? server.url : [server.command, ...server.args].join(' ')
}

export function McpServers() {
  const { data, error, mutate } = useMcpServers()
  const { projects, refresh } = useAppData()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const servers = data?.servers ?? []
  const nameValid = draft === null || draft.name === '' || MCP_SERVER_NAME_RE.test(draft.name)

  /** Threads carry the count of servers that apply, so the thread list reloads too. */
  async function reload(): Promise<void> {
    await mutate()
    await refresh()
  }

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!draft) return
    setSaving(true)
    try {
      const input = toInput(draft)
      if (draft.id) await api.mcpServers.update(draft.id, input)
      else await api.mcpServers.create(input)
      await reload()
      setDraft(null)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  async function toggle(server: McpServer, enabled: boolean): Promise<void> {
    setBusyId(server.id)
    try {
      await api.mcpServers.update(server.id, toInput({ ...toDraft(server), enabled }))
      await reload()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusyId(null)
    }
  }

  async function remove(id: string): Promise<void> {
    setBusyId(id)
    try {
      await api.mcpServers.remove(id)
      await reload()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">MCP servers</h2>
        <Button size="sm" variant="outline" onClick={() => setDraft(emptyDraft)}>
          Add server
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(error)}
        </p>
      )}
      {servers.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead className="w-0">Enabled</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {servers.map((server) => (
              <TableRow key={server.id}>
                <TableCell className={`font-mono text-xs ${server.enabled ? '' : 'text-muted-foreground'}`}>{server.name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{server.type}</TableCell>
                <TableCell className="max-w-xs truncate font-mono text-xs text-muted-foreground">{target(server)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {server.scope === 'all' ? (
                    'All projects'
                  ) : (
                    <span className="tabular-nums">
                      {server.projectIds.length} {server.projectIds.length === 1 ? 'project' : 'projects'}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <Switch
                    checked={server.enabled}
                    disabled={busyId === server.id}
                    aria-label={`${server.name} enabled`}
                    onCheckedChange={(c) => void toggle(server, c)}
                  />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Button size="xs" variant="ghost" onClick={() => setDraft(toDraft(server))}>
                    Edit
                  </Button>
                  <Button size="xs" variant="ghost" disabled={busyId === server.id} onClick={() => void remove(server.id)}>
                    Delete
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <ProjectMcpJson />

      <Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          {draft && (
            <form onSubmit={save} className="flex flex-col gap-4">
              <DialogHeader>
                <DialogTitle>{draft.id ? 'Edit server' : 'Add server'}</DialogTitle>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mcp-name">Name</Label>
                  <Input
                    id="mcp-name"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    aria-invalid={!nameValid}
                    className="font-mono"
                    autoFocus={!draft.id}
                    required
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mcp-type">Type</Label>
                  <Select
                    value={draft.type}
                    onValueChange={(v) => setDraft({ ...draft, type: v as McpServerType, values: [] })}
                  >
                    <SelectTrigger id="mcp-type" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="http">HTTP</SelectItem>
                      <SelectItem value="stdio">Stdio</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {draft.type === 'http' ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mcp-url">URL</Label>
                  <Input
                    id="mcp-url"
                    value={draft.url}
                    onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                    placeholder="https://api.example.com/mcp"
                    className="font-mono"
                    required
                  />
                </div>
              ) : (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="mcp-command">Command</Label>
                    <Input
                      id="mcp-command"
                      value={draft.command}
                      onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                      placeholder="npx"
                      className="font-mono"
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="mcp-args">Arguments, one per line</Label>
                    <Textarea
                      id="mcp-args"
                      value={draft.args}
                      onChange={(e) => setDraft({ ...draft, args: e.target.value })}
                      rows={3}
                      className="font-mono"
                    />
                  </div>
                </>
              )}

              <Values
                label={draft.type === 'http' ? 'Headers' : 'Environment'}
                values={draft.values}
                onChange={(values) => setDraft({ ...draft, values })}
              />

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mcp-scope">Scope</Label>
                <Select value={draft.scope} onValueChange={(v) => setDraft({ ...draft, scope: v as McpServerScope })}>
                  <SelectTrigger id="mcp-scope" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All projects</SelectItem>
                    <SelectItem value="selected">Selected projects</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {draft.scope === 'selected' && (
                <div className="flex flex-col gap-2">
                  {projects.map((project) => (
                    <div key={project.id} className="flex items-center gap-2">
                      <Switch
                        id={`mcp-project-${project.id}`}
                        checked={draft.projectIds.includes(project.id)}
                        onCheckedChange={(c) =>
                          setDraft({
                            ...draft,
                            projectIds: c
                              ? [...draft.projectIds, project.id]
                              : draft.projectIds.filter((id) => id !== project.id),
                          })
                        }
                      />
                      <Label htmlFor={`mcp-project-${project.id}`}>{project.name}</Label>
                    </div>
                  ))}
                </div>
              )}

              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={saving || !nameValid || (draft.scope === 'selected' && draft.projectIds.length === 0)}
                >
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

function ProjectMcpJson() {
  const { data: settings, mutate } = useSettings()
  const [busy, setBusy] = useState(false)
  if (!settings) return null

  async function change(allowProjectMcpJson: boolean): Promise<void> {
    setBusy(true)
    try {
      await mutate(await api.settings.update({ allowProjectMcpJson }), { revalidate: false })
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Switch
        id="mcp-project-json"
        checked={settings.allowProjectMcpJson}
        disabled={busy}
        onCheckedChange={(c) => void change(c)}
      />
      <Label htmlFor="mcp-project-json">
        Load <span className="font-mono">.mcp.json</span> from repositories
      </Label>
    </div>
  )
}

function Values({
  label,
  values,
  onChange,
}: {
  label: string
  values: ValueDraft[]
  onChange: (values: ValueDraft[]) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => onChange([...values, { name: '', value: '', stored: false }])}
        >
          Add
        </Button>
      </div>
      {values.map((value, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={value.name}
            onChange={(e) => onChange(values.map((v, j) => (i === j ? { ...v, name: e.target.value } : v)))}
            aria-label={`${label} name`}
            className="font-mono"
            required
          />
          <Input
            type="password"
            value={value.value}
            onChange={(e) => onChange(values.map((v, j) => (i === j ? { ...v, value: e.target.value } : v)))}
            aria-label={`${label} value`}
            placeholder={value.stored ? 'Unchanged' : undefined}
            required={!value.stored}
            className="font-mono"
          />
          <Button type="button" size="xs" variant="ghost" onClick={() => onChange(values.filter((_, j) => i !== j))}>
            Remove
          </Button>
        </div>
      ))}
    </div>
  )
}
