import { ProjectView } from '@/components/projects/project-view'

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <ProjectView id={id} />
}
