'use client'

import { memo, useMemo, type ReactNode } from 'react'
import type { ToolItem, Turn, TurnItem } from '@valet/shared'
import { duration, tokens, usd } from '@/lib/format'
import { PermissionItemView } from '@/components/thread/items/permission-item'
import { QuestionItemView } from '@/components/thread/items/question-item'
import { ReasoningItemView } from '@/components/thread/items/reasoning-item'
import { TextItemView } from '@/components/thread/items/text-item'
import { ToolGroup } from '@/components/thread/items/tool-group'

export const TurnView = memo(function TurnView({ threadId, turn }: { threadId: string; turn: Turn }) {
  const blocks = useMemo(() => groupItems(turn.items), [turn.items])
  return (
    <article className="flex flex-col gap-3">
      <UserPrompt prompt={turn.prompt} />
      {blocks.map((block) => {
        if (block.kind === 'tools') {
          return <ToolGroup key={block.key} tools={block.tools} children={block.children} />
        }
        return <ItemView key={block.key} threadId={threadId} item={block.item} />
      })}
      {turn.status !== 'running' && <TurnFooter turn={turn} />}
    </article>
  )
})

function UserPrompt({ prompt }: { prompt: Turn['prompt'] }) {
  if (!prompt.text && prompt.images.length === 0) return null
  return (
    <div className="flex flex-col gap-2 rounded-md bg-secondary px-4 py-3 text-sm">
      {prompt.text && <p className="whitespace-pre-wrap">{prompt.text}</p>}
      {prompt.images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {prompt.images.map((img, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={img.dataUrl} alt="" className="max-h-48 rounded-md" />
          ))}
        </div>
      )}
    </div>
  )
}

function ItemView({ threadId, item }: { threadId: string; item: TurnItem }): ReactNode {
  switch (item.kind) {
    case 'text':
      return <TextItemView item={item} />
    case 'reasoning':
      return <ReasoningItemView item={item} />
    case 'permission':
      return <PermissionItemView threadId={threadId} item={item} />
    case 'question':
      return <QuestionItemView threadId={threadId} item={item} />
    case 'steer':
      return <div className="rounded-md border-l-2 bg-secondary/50 px-3 py-1.5 text-sm">{item.text}</div>
    case 'error':
      return (
        <div role="alert" className="border-l-2 border-destructive pl-3 text-sm text-destructive">
          {item.message}
        </div>
      )
    case 'tool':
      return null
    default: {
      const _exhaustive: never = item
      return _exhaustive
    }
  }
}

function TurnFooter({ turn }: { turn: Turn }) {
  const u = turn.usage
  const parts: string[] = []
  const d = duration(turn.startedAt, turn.endedAt)
  if (d) parts.push(d)
  if (u) parts.push(`${tokens(u.inputTokens)} in`, `${tokens(u.outputTokens)} out`)
  const cost = usd(u?.costUsd)
  if (cost) parts.push(cost)
  return (
    <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
      {turn.status === 'interrupted' && <span>Interrupted</span>}
      {turn.status === 'failed' && <span className="text-destructive">Failed{turn.error ? `: ${turn.error}` : ''}</span>}
      {parts.map((p) => (
        <span key={p}>{p}</span>
      ))}
    </footer>
  )
}

type Block =
  | { kind: 'item'; key: string; item: Exclude<TurnItem, ToolItem> }
  | { kind: 'tools'; key: string; tools: ToolItem[]; children: Map<string, ToolItem[]> }

/**
 * Top-level tool calls that follow each other become one block; subagent calls
 * (with a parent) hang off their parent instead of appearing in the flow.
 */
function groupItems(items: TurnItem[]): Block[] {
  const children = new Map<string, ToolItem[]>()
  for (const it of items) {
    if (it.kind === 'tool' && it.parentItemId) {
      const list = children.get(it.parentItemId) ?? []
      list.push(it)
      children.set(it.parentItemId, list)
    }
  }
  const blocks: Block[] = []
  let run: ToolItem[] = []
  const flush = (): void => {
    if (run.length > 0) blocks.push({ kind: 'tools', key: `tools-${run[0]!.id}`, tools: run, children })
    run = []
  }
  for (const it of items) {
    if (it.kind === 'tool') {
      if (it.parentItemId) continue
      run.push(it)
      continue
    }
    flush()
    blocks.push({ kind: 'item', key: `${it.kind}-${it.id}`, item: it })
  }
  flush()
  return blocks
}
