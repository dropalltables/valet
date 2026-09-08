import type { ReactNode } from 'react'
import { DataProvider } from '@/components/app/data-provider'
import { HealthGate } from '@/components/app/health-gate'
import { Sidebar } from '@/components/app/sidebar'

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <HealthGate>
      <DataProvider>
        <div className="flex h-full">
          <Sidebar />
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
        </div>
      </DataProvider>
    </HealthGate>
  )
}
