'use client'

import { useMemo, useState } from 'react'
import type { FileChange, ToolItem } from '@valet/shared'
import { ChevronRightIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { stripAnsi } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Spinner } from '@/components/ui/spinner'
import { ContentsDiffView, PatchView } from '@/components/diff/diff-view'

const OUTPUT_PREVIEW_LINES = 200

type Props = {
  tools: ToolItem[]
  /** Subagent tool calls keyed by the parent tool's item id. */
  children: Map<string, ToolItem[]>
}

/**
 * Consecutive tool calls collapse into one summary line ("Edited 2 files").
 * While one is running the summary shows its title, so the line changes in
 * place instead of growing.
 */
export function ToolGroup({ tools, children }: Props) {
  const [open, setOpen] = useState(false)
  if (tools.length === 1 && tools[0]) return <ToolRow tool={tools[0]} childTools={children.get(tools[0].id) ?? []} />

  const running = tools.find((t) => t.state === 'running')
  const failed = tools.filter((t) => t.state === 'error').length

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/tools">
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm hover:bg-accent/50">
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/tools:rotate-90" />
        <span className="shrink-0 text-muted-foreground">{summarize(tools)}</span>
        {running ? (
          <>
            <Spinner className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{running.title}</span>
          </>
        ) : failed > 0 ? (
          <span className="text-xs text-destructive">
            {failed} failed
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-0.5 pl-5">
        {tools.map((t) => (
          <ToolRow key={t.id} tool={t} childTools={children.get(t.id) ?? []} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

function summarize(tools: ToolItem[]): string {
  const n = tools.length
  const names = new Set(tools.map((t) => t.name))
  const only = (...allowed: string[]) => [...names].every((x) => allowed.includes(x))
  if (only('edit', 'write')) return `Edited ${n} files`
  if (only('bash')) return `Ran ${n} commands`
  if (only('read')) return `Read ${n} files`
  if (only('grep', 'glob')) return `Searched ${n} times`
  if (only('web_search', 'web_fetch')) return `${n} web lookups`
  return `${n} tool calls`
}

export function ToolRow({ tool, childTools }: { tool: ToolItem; childTools: ToolItem[] }) {
  const [open, setOpen] = useState(false)
  const mono = tool.name === 'bash' || tool.name.startsWith('mcp:')
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/tool">
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm hover:bg-accent/50">
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/tool:rotate-90" />
        {tool.state === 'running' && <Spinner className="size-3.5 shrink-0" />}
        <span className={cn('min-w-0 flex-1 truncate', mono && 'font-mono text-xs')}>{tool.title || tool.name}</span>
        {tool.state === 'error' && (
          <span className="shrink-0 text-xs text-destructive">
            {tool.exitCode !== null && tool.exitCode !== 0 ? `Exit ${tool.exitCode}` : 'Failed'}
          </span>
        )}
        {tool.state === 'done' && childTools.length > 0 && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{childTools.length} calls</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="pl-5">
        {open && <ToolDetail tool={tool} childTools={childTools} />}
      </CollapsibleContent>
    </Collapsible>
  )
}

function ToolDetail({ tool, childTools }: { tool: ToolItem; childTools: ToolItem[] }) {
  return (
    <div className="flex flex-col gap-3 py-2">
      <ToolInputView tool={tool} />
      {childTools.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {childTools.map((c) => (
            <ToolRow key={c.id} tool={c} childTools={[]} />
          ))}
        </div>
      )}
      {(tool.output || tool.state === 'error') && <ToolOutputView tool={tool} />}
    </div>
  )
}

function str(input: unknown, key: string): string | null {
  if (typeof input !== 'object' || input === null) return null
  const v = (input as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : null
}

function ToolInputView({ tool }: { tool: ToolItem }) {
  const changesWithDiff = (tool.fileChanges ?? []).filter((c): c is FileChange & { diff: string } => !!c.diff)
  if (changesWithDiff.length > 0) {
    return (
      <div className="flex flex-col gap-2">
        {changesWithDiff.map((c) => (
          <div key={c.path} className="rounded-md border">
            <div className="flex items-center gap-2 px-3 py-1.5 font-mono text-xs text-muted-foreground">
              <span>{c.kind}</span>
              <span className="text-foreground">{c.path}</span>
            </div>
            <PatchView patch={c.diff} />
          </div>
        ))}
      </div>
    )
  }

  const path = str(tool.input, 'file_path') ?? str(tool.input, 'path')
  if (tool.name === 'edit' && path) {
    const oldText = str(tool.input, 'old_string')
    const newText = str(tool.input, 'new_string')
    if (oldText !== null && newText !== null) {
      return (
        <div className="rounded-md border">
          <ContentsDiffView path={path} oldText={oldText} newText={newText} />
        </div>
      )
    }
  }
  if (tool.name === 'write' && path) {
    const content = str(tool.input, 'content')
    if (content !== null) {
      return (
        <div className="rounded-md border">
          <ContentsDiffView path={path} oldText="" newText={content} />
        </div>
      )
    }
  }
  if (tool.name === 'bash') {
    const command = str(tool.input, 'command')
    if (command !== null) return <Mono text={command} />
  }
  if (tool.input === null || tool.input === undefined || (typeof tool.input === 'object' && Object.keys(tool.input).length === 0)) {
    return null
  }
  return <Mono text={typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input, null, 2)} />
}

function ToolOutputView({ tool }: { tool: ToolItem }) {
  const [all, setAll] = useState(false)
  const lines = useMemo(() => stripAnsi(tool.output).replace(/\s+$/, '').split('\n'), [tool.output])
  const overflow = lines.length > OUTPUT_PREVIEW_LINES
  const shown = all || !overflow ? lines : lines.slice(0, OUTPUT_PREVIEW_LINES)
  return (
    <div className="flex flex-col gap-1">
      <Mono text={shown.join('\n')} error={tool.isError} />
      {overflow && !all && (
        <div>
          <Button variant="ghost" size="xs" onClick={() => setAll(true)}>
            Show more
            <span className="text-muted-foreground tabular-nums">{lines.length - OUTPUT_PREVIEW_LINES} lines</span>
          </Button>
        </div>
      )}
    </div>
  )
}

function Mono({ text, error = false }: { text: string; error?: boolean }) {
  return (
    <pre
      className={cn(
        'max-h-96 overflow-auto rounded-md bg-muted/50 p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-words',
        error && 'text-destructive',
      )}
    >
      {text}
    </pre>
  )
}
