'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import { MenuIcon, PlusIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet'
import { Sidebar } from '@/components/app/sidebar'

/**
 * The sidebar sits beside the content on a wide screen. On a phone it becomes a
 * drawer behind a menu button in a top bar, and closes when a link in it is followed.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setOpen(false)
  }, [pathname])

  return (
    <div className="flex h-full flex-col md:flex-row">
      <Sidebar className="hidden w-72 border-r md:flex" />
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5 md:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="Open menu">
              <MenuIcon />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" title="Threads" showCloseButton={false} className="w-[85vw] max-w-xs">
            <Sidebar className="w-full" />
          </SheetContent>
        </Sheet>
        <Link href="/" className="px-1 text-sm font-medium">
          Valet
        </Link>
        <span className="flex-1" />
        <Button asChild size="icon-sm" variant="ghost">
          <Link href="/" aria-label="New thread">
            <PlusIcon />
          </Link>
        </Button>
      </div>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
    </div>
  )
}
