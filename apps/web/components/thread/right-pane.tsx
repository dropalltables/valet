'use client'

import dynamic from 'next/dynamic'
import { useState } from 'react'
import { LIVE_STATUSES, type Portal, type Project, type Service, type ThreadListItem } from '@valet/shared'
import { api } from '@/lib/api'
import { serviceRowCount } from '@/lib/stream'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ChangesPanel } from '@/components/panels/changes-panel'
import { FilesPanel } from '@/components/panels/files-panel'
import { PaneState } from '@/components/panels/pane-state'
import { ServicesPanel } from '@/components/panels/services-panel'
import type { ThreadActions } from '@/components/thread/thread-actions'

const TerminalPanel = dynamic(() => import('@/components/panels/terminal-panel'), { ssr: false })
const DesktopPanel = dynamic(() => import('@/components/panels/desktop-panel'), { ssr: false })

export type RightPaneTab = 'changes' | 'services' | 'files' | 'terminal' | 'desktop'

export function RightPane({
  thread,
  actions,
  portals,
  services,
  tab,
  onTabChange,
}: {
  thread: ThreadListItem
  project: Project | undefined
  actions: ThreadActions
  portals: Portal[]
  services: Service[]
  tab: RightPaneTab
  onTabChange: (tab: RightPaneTab) => void
}) {
  // Terminal and desktop open a socket when mounted, so they mount on first
  // visit and then stay mounted (hidden) to keep their sessions across switches.
  const [visited, setVisited] = useState<ReadonlySet<RightPaneTab>>(() => new Set([tab]))
  const live = LIVE_STATUSES.includes(thread.status)
  const rows = serviceRowCount(services, portals)

  function select(next: string): void {
    const t = next as RightPaneTab
    onTabChange(t)
    if (!visited.has(t)) setVisited(new Set([...visited, t]))
  }

  return (
    <Tabs value={tab} onValueChange={select} className="h-full gap-0">
      <TabsList variant="line" className="w-full justify-start rounded-none border-b px-2">
        <TabsTrigger value="changes" className="flex-none px-2">
          Changes
        </TabsTrigger>
        <TabsTrigger value="services" className="flex-none px-2">
          Services
          {rows > 0 && (
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px] tabular-nums">
              {rows}
            </Badge>
          )}
        </TabsTrigger>
        <TabsTrigger value="files" className="flex-none px-2">
          Files
        </TabsTrigger>
        <TabsTrigger value="terminal" className="flex-none px-2">
          Terminal
        </TabsTrigger>
        <TabsTrigger value="desktop" className="flex-none px-2">
          Desktop
        </TabsTrigger>
      </TabsList>
      <TabsContent value="changes" className="min-h-0 flex-1">
        <ChangesPanel status={thread.status} source={thread.id} load={() => api.threads.changes(thread.id)} actions={actions} />
      </TabsContent>
      <TabsContent value="services" className="min-h-0 flex-1">
        <ServicesPanel thread={thread} services={services} portals={portals} actions={actions} />
      </TabsContent>
      <TabsContent value="files" className="min-h-0 flex-1">
        <FilesPanel thread={thread} actions={actions} />
      </TabsContent>
      <TabsContent value="terminal" forceMount className="min-h-0 flex-1 data-[state=inactive]:hidden">
        {visited.has('terminal') &&
          (live ? (
            <TerminalPanel threadId={thread.id} />
          ) : (
            <PaneState status={thread.status} onWake={actions.wake} waking={actions.busy === 'wake'} />
          ))}
      </TabsContent>
      <TabsContent value="desktop" forceMount className="min-h-0 flex-1 data-[state=inactive]:hidden">
        {visited.has('desktop') &&
          (live ? (
            <DesktopPanel threadId={thread.id} />
          ) : (
            <PaneState status={thread.status} onWake={actions.wake} waking={actions.busy === 'wake'} />
          ))}
      </TabsContent>
    </Tabs>
  )
}
