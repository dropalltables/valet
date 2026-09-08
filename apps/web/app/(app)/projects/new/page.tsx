'use client'

import { useRouter } from 'next/navigation'
import { NewProjectForm } from '@/components/composer/new-project-form'

export default function NewProjectPage() {
  const router = useRouter()
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-10">
        <h1 className="text-lg font-medium">New project</h1>
        <NewProjectForm onCreated={(p) => router.push(`/projects/${p.id}`)} onCancel={() => router.push('/projects')} />
      </div>
    </div>
  )
}
