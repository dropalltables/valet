'use client'

import Link from 'next/link'
import { PlusIcon } from 'lucide-react'
import { relativeTime, repoSlug } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useAppData } from '@/components/app/data-provider'

export default function ProjectsPage() {
  const { projects, threads, loaded } = useAppData()
  const counts = new Map<string, number>()
  for (const t of threads) counts.set(t.projectId, (counts.get(t.projectId) ?? 0) + 1)

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-medium">Projects</h1>
          <Button asChild size="sm">
            <Link href="/projects/new">
              <PlusIcon />
              New project
            </Link>
          </Button>
        </div>
        {loaded && projects.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Default branch</TableHead>
                <TableHead className="text-right">Threads</TableHead>
                <TableHead className="text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="max-w-xs truncate">
                    <Link href={`/projects/${p.id}`} className="font-medium hover:underline">
                      {p.name}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {p.repoUrl ? repoSlug(p.repoUrl) : 'Blank'}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{p.defaultBranch}</TableCell>
                  <TableCell className="text-right tabular-nums">{counts.get(p.id) ?? 0}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{relativeTime(p.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}
