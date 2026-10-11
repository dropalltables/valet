import type { ReactNode } from 'react'
import { DataProvider } from '@/components/app/data-provider'
import { HealthGate } from '@/components/app/health-gate'
import { AppShell } from '@/components/app/app-shell'

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <HealthGate>
      <DataProvider>
        <AppShell>{children}</AppShell>
      </DataProvider>
    </HealthGate>
  )
}
