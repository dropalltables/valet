'use client'

import type { Project } from '@valet/shared'
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'

const NEW = '__new__'

type Props = {
  projects: Project[]
  value: string | null
  onChange: (projectId: string) => void
  /** The trailing "New project" entry toggles this; the caller renders the form. */
  creating: boolean
  onCreatingChange: (creating: boolean) => void
  size?: 'sm' | 'default'
  triggerClassName?: string
}

export function ProjectPicker({
  projects,
  value,
  onChange,
  creating,
  onCreatingChange,
  size = 'default',
  triggerClassName = 'min-w-40',
}: Props) {
  return (
    <Select
      value={creating ? NEW : (value ?? '')}
      onValueChange={(v) => {
        if (v === NEW) {
          onCreatingChange(true)
          return
        }
        onCreatingChange(false)
        onChange(v)
      }}
    >
      <SelectTrigger size={size} aria-label="Project" className={triggerClassName}>
        <SelectValue placeholder="Project" />
      </SelectTrigger>
      <SelectContent>
        {projects.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
          </SelectItem>
        ))}
        {projects.length > 0 && <SelectSeparator />}
        <SelectItem value={NEW}>New project</SelectItem>
      </SelectContent>
    </Select>
  )
}
