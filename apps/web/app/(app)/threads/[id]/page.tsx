import { ThreadView } from '@/components/thread/thread-view'

export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <ThreadView id={id} />
}
