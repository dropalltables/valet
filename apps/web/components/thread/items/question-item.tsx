'use client'

import { useState, type FormEvent } from 'react'
import type { Question, QuestionItem } from '@valet/shared'
import { toast } from 'sonner'
import { api, errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

export function QuestionItemView({ threadId, item }: { threadId: string | null; item: QuestionItem }) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [busy, setBusy] = useState(false)
  const answered = item.answers
  const locked = threadId === null || answered !== null

  const complete = item.questions.every((q) => (answers[q.id]?.length ?? 0) > 0 && answers[q.id]?.some((a) => a.trim()))

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (threadId === null) return
    setBusy(true)
    try {
      await api.threads.answer(threadId, item.id, { answers })
    } catch (err) {
      toast.error(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-md border p-3 text-sm">
      {item.questions.map((q) => (
        <QuestionField
          key={q.id}
          question={q}
          value={answered ? (answered[q.id] ?? []) : (answers[q.id] ?? [])}
          readOnly={locked}
          onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))}
        />
      ))}
      {!locked && (
        <div>
          <Button type="submit" size="sm" disabled={!complete || busy}>
            Answer
          </Button>
        </div>
      )}
    </form>
  )
}

function QuestionField({
  question,
  value,
  readOnly,
  onChange,
}: {
  question: Question
  value: string[]
  readOnly: boolean
  onChange: (v: string[]) => void
}) {
  const hasOptions = question.options.length > 0

  function toggle(label: string): void {
    if (readOnly) return
    if (question.multiSelect) onChange(value.includes(label) ? value.filter((v) => v !== label) : [...value, label])
    else onChange([label])
  }

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 font-medium">{question.question}</legend>
      {hasOptions ? (
        <div className="flex flex-col gap-1">
          {question.options.map((o) => {
            const selected = value.includes(o.label)
            return (
              <button
                key={o.label}
                type="button"
                role={question.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={selected}
                disabled={readOnly}
                onClick={() => toggle(o.label)}
                className={cn(
                  'flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left',
                  selected ? 'border-foreground bg-accent' : 'hover:bg-accent/50',
                  readOnly && !selected && 'opacity-50',
                )}
              >
                <span>{o.label}</span>
                {o.description && <span className="text-xs text-muted-foreground">{o.description}</span>}
              </button>
            )
          })}
        </div>
      ) : readOnly ? (
        <p className="whitespace-pre-wrap break-words">{value.join('\n')}</p>
      ) : (
        <Textarea value={value[0] ?? ''} onChange={(e) => onChange([e.target.value])} rows={3} />
      )}
    </fieldset>
  )
}
