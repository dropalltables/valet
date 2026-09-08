'use client'

import { useEffect, useState } from 'react'

function hasFiles(e: DragEvent): boolean {
  return e.dataTransfer?.types?.includes('Files') ?? false
}

/**
 * Page-wide drop target state. Purely visual: the actual drop is handled by
 * PromptInput's `globalDrop`, so this stays `pointer-events-none` and only tracks
 * whether a file drag is over the window (enter/leave pairs nest, hence the depth).
 */
export function DropOverlay({ label = 'Drop images here' }: { label?: string }) {
  const [active, setActive] = useState(false)

  useEffect(() => {
    let depth = 0
    const reset = (): void => {
      depth = 0
      setActive(false)
    }
    const onEnter = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      depth++
      setActive(true)
    }
    const onLeave = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setActive(false)
    }
    document.addEventListener('dragenter', onEnter)
    document.addEventListener('dragleave', onLeave)
    document.addEventListener('drop', reset)
    window.addEventListener('dragend', reset)
    return () => {
      document.removeEventListener('dragenter', onEnter)
      document.removeEventListener('dragleave', onLeave)
      document.removeEventListener('drop', reset)
      window.removeEventListener('dragend', reset)
    }
  }, [])

  if (!active) return null
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-50 bg-background/80 p-3">
      <div className="flex h-full w-full items-center justify-center rounded-lg border-2 border-dashed border-foreground/40 text-sm">
        {label}
      </div>
    </div>
  )
}
