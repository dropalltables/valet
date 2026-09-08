'use client'

import { Component, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTheme } from 'next-themes'
import { preloadHighlighter } from '@pierre/diffs'
import { MultiFileDiff, PatchDiff, type FileDiffOptions } from '@pierre/diffs/react'

export type DiffStyle = 'unified' | 'split'

type Options = FileDiffOptions<undefined, undefined>

const THEMES = { light: 'github-light', dark: 'github-dark' } as const

let preload: Promise<void> | null = null

/**
 * A diff rendered before the shared highlighter has its themes stays blank:
 * the first render bails out and the async highlight result never reaches the
 * DOM. Preloading the themes once makes every first render synchronous.
 */
function useHighlighterReady(): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let active = true
    preload ??= preloadHighlighter({ themes: [THEMES.light, THEMES.dark], langs: [] })
    preload.then(() => {
      if (active) setReady(true)
    })
    return () => {
      active = false
    }
  }, [])
  return ready
}

function useDiffOptions(diffStyle: DiffStyle): Options {
  const { resolvedTheme } = useTheme()
  const themeType = resolvedTheme === 'dark' ? 'dark' : 'light'
  return useMemo<Options>(
    () => ({
      theme: THEMES,
      themeType,
      diffStyle,
      diffIndicators: 'bars',
      disableFileHeader: true,
      overflow: 'scroll',
    }),
    [themeType, diffStyle],
  )
}

/** Renders one file's unified patch (with its `diff --git` header). */
export function PatchView({ patch, diffStyle = 'unified' }: { patch: string; diffStyle?: DiffStyle }) {
  const options = useDiffOptions(diffStyle)
  if (!useHighlighterReady()) return null
  return (
    <DiffBoundary fallback={<RawPatch text={patch} />}>
      <PatchDiff patch={patch} options={options} className="text-xs" />
    </DiffBoundary>
  )
}

/** Renders the diff between two versions of one file. */
export function ContentsDiffView({
  path,
  oldText,
  newText,
  diffStyle = 'unified',
}: {
  path: string
  oldText: string
  newText: string
  diffStyle?: DiffStyle
}) {
  const options = useDiffOptions(diffStyle)
  const oldFile = useMemo(() => ({ name: path, contents: oldText }), [path, oldText])
  const newFile = useMemo(() => ({ name: path, contents: newText }), [path, newText])
  const ready = useHighlighterReady()
  if (!ready) return null
  return (
    <DiffBoundary fallback={<RawPatch text={`--- ${path}\n+++ ${path}\n-${oldText}\n+${newText}`} />}>
      <MultiFileDiff oldFile={oldFile} newFile={newFile} options={options} className="text-xs" />
    </DiffBoundary>
  )
}

function RawPatch({ text }: { text: string }) {
  return <pre className="overflow-x-auto p-3 font-mono text-xs whitespace-pre">{text}</pre>
}

type BoundaryProps = { children: ReactNode; fallback: ReactNode }

/** A malformed patch must not take the transcript down with it. */
class DiffBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
