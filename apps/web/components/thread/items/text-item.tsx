'use client'

import type { TextItem } from '@valet/shared'
import { MessageResponse } from '@/components/ai-elements/message'

export function TextItemView({ item }: { item: TextItem }) {
  return (
    <div className="text-sm leading-relaxed">
      <MessageResponse isAnimating={!item.done}>{item.text}</MessageResponse>
    </div>
  )
}
