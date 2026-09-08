'use client'

import type { ReasoningItem } from '@valet/shared'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { Shimmer } from '@/components/ai-elements/shimmer'

function thinkingMessage(isStreaming: boolean, duration?: number) {
  if (isStreaming || duration === 0) return <Shimmer duration={1}>Thinking</Shimmer>
  if (duration === undefined) return <p>Thought</p>
  return <p>Thought for {duration === 1 ? '1 second' : `${duration} seconds`}</p>
}

export function ReasoningItemView({ item }: { item: ReasoningItem }) {
  return (
    <Reasoning isStreaming={!item.done} className="mb-0">
      <ReasoningTrigger getThinkingMessage={thinkingMessage} />
      <ReasoningContent className="mt-2 border-l-2 pl-3">{item.text}</ReasoningContent>
    </Reasoning>
  )
}
