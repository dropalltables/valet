import { NewThreadComposer } from '@/components/composer/new-thread-composer'

export default function HomePage() {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 pt-[18vh] pb-12">
        <h1 className="text-lg font-medium">New thread</h1>
        <NewThreadComposer />
      </div>
    </div>
  )
}
