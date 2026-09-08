import type { Metadata } from 'next'
import { SharedThreadView } from '@/components/thread/shared-thread-view'

export const metadata: Metadata = { robots: { index: false, follow: false } }

export default async function SharedThreadPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <SharedThreadView token={token} />
}
