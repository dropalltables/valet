'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useEffect, useMemo, useState, useSyncExternalStore, type ClipboardEvent, type KeyboardEvent } from 'react'
import { DEFAULT_MODEL, DEFAULT_MODELS, type AgentKind, type PermissionPolicy } from '@valet/shared'
import { ImageIcon } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage } from '@/lib/api'
import { useAgents, useBranches, useSettings } from '@/lib/hooks'
import {
  PromptInput,
  PromptInputButton,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputTools,
  usePromptInputAttachments,
  usePromptInputController,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input'
import { Button } from '@/components/ui/button'
import { InputGroupTextarea } from '@/components/ui/input-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppData } from '@/components/app/data-provider'
import { AttachmentStrip } from '@/components/composer/attachments'
import { NewProjectForm } from '@/components/composer/new-project-form'
import { ProjectPicker } from '@/components/composer/project-picker'

export function NewThreadComposer() {
  return (
    <PromptInputProvider>
      <Composer />
    </PromptInputProvider>
  )
}

function Composer() {
  const router = useRouter()
  const { projects, upsertThread } = useAppData()
  const { data: agentsData } = useAgents()
  const { data: settings } = useSettings()
  const { textInput } = usePromptInputController()
  const modKey = useModKey()

  const [projectId, setProjectId] = useState<string | null>(null)
  const [creatingProject, setCreatingProject] = useState(false)
  const [baseBranch, setBaseBranch] = useState<string | null>(null)
  const [agent, setAgent] = useState<AgentKind | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [permissions, setPermissions] = useState<PermissionPolicy | null>(null)
  const [busy, setBusy] = useState(false)

  const project = projects.find((p) => p.id === projectId) ?? null
  const { data: branchData } = useBranches(project?.source === 'github' ? project.repoUrl : null)
  const agents = agentsData?.agents ?? []

  // Defaults: settings first, then the first available agent.
  useEffect(() => {
    if (agent || agents.length === 0) return
    const preferred = settings?.defaultAgent
    const pick = agents.find((a) => a.id === preferred && a.available) ?? agents.find((a) => a.available)
    if (pick) setAgent(pick.id)
  }, [agent, agents, settings])
  useEffect(() => {
    if (permissions || !settings) return
    setPermissions(settings.defaultPermissions)
  }, [permissions, settings])
  useEffect(() => {
    if (projectId || projects.length === 0) return
    setProjectId(projects[0]?.id ?? null)
  }, [projectId, projects])

  const agentInfo = agents.find((a) => a.id === agent) ?? null
  const noAgent = agents.length > 0 && !agents.some((a) => a.available)
  const models = useMemo(() => {
    if (agentInfo && agentInfo.models.length > 0) return agentInfo.models
    return agent ? DEFAULT_MODELS[agent] : []
  }, [agentInfo, agent])
  const effectiveModel =
    model && models.some((m) => m.id === model)
      ? model
      : (agent && settings?.defaultModel[agent]) || agentInfo?.defaultModel || (agent ? DEFAULT_MODEL[agent] : null)

  const branches = branchData?.branches ?? (project ? [project.defaultBranch] : [])
  const effectiveBranch = baseBranch && branches.includes(baseBranch) ? baseBranch : (project?.defaultBranch ?? null)

  const canSubmit =
    !busy &&
    !!project &&
    !!agentInfo?.available &&
    !!effectiveModel &&
    !!effectiveBranch &&
    textInput.value.trim().length > 0

  async function submit(message: PromptInputMessage): Promise<void> {
    if (!project || !agent || !effectiveModel || !effectiveBranch) return
    const prompt = message.text.trim()
    if (!prompt) return
    setBusy(true)
    try {
      const thread = await api.threads.create({
        projectId: project.id,
        prompt,
        images: message.files
          .filter((f) => f.url.startsWith('data:'))
          .map((f) => ({ mediaType: f.mediaType, dataUrl: f.url })),
        agent,
        model: effectiveModel,
        permissions: permissions ?? 'auto',
        baseBranch: effectiveBranch,
      })
      upsertThread({ ...thread, projectName: project.name, diffStats: null })
      router.push(`/threads/${thread.id}`)
    } catch (err) {
      toast.error(errorMessage(err))
      setBusy(false)
      throw err
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <PromptInput onSubmit={submit} accept="image/*" multiple className="flex flex-col">
        <AttachmentStrip />
        <ComposerTextarea disabled={busy} canSubmit={canSubmit} />
        <PromptInputFooter className="flex-nowrap items-center gap-2">
          <PromptInputTools className="min-w-0 flex-1 flex-nowrap gap-2 overflow-x-auto">
            <ProjectPicker
              projects={projects}
              value={projectId}
              onChange={setProjectId}
              creating={creatingProject}
              onCreatingChange={setCreatingProject}
              size="sm"
            />
            <PromptInputSelect
              value={effectiveBranch ?? ''}
              onValueChange={setBaseBranch}
              disabled={!project}
            >
              <PromptInputSelectTrigger size="sm" aria-label="Base branch" className="font-mono text-xs">
                <PromptInputSelectValue placeholder="Branch" />
              </PromptInputSelectTrigger>
              <PromptInputSelectContent>
                {branches.map((b) => (
                  <PromptInputSelectItem key={b} value={b} className="font-mono text-xs">
                    {b}
                  </PromptInputSelectItem>
                ))}
              </PromptInputSelectContent>
            </PromptInputSelect>
            <PromptInputSelect
              value={agent ?? ''}
              onValueChange={(v) => {
                setAgent(v as AgentKind)
                setModel(null)
              }}
            >
              <PromptInputSelectTrigger size="sm" aria-label="Agent">
                <PromptInputSelectValue placeholder="Agent" />
              </PromptInputSelectTrigger>
              <PromptInputSelectContent>
                {agents.map((a) =>
                  a.available ? (
                    <PromptInputSelectItem key={a.id} value={a.id}>
                      {a.label}
                    </PromptInputSelectItem>
                  ) : (
                    <Tooltip key={a.id}>
                      <TooltipTrigger asChild>
                        <div>
                          <PromptInputSelectItem value={a.id} disabled>
                            {a.label}
                            <span className="ml-2 text-xs text-muted-foreground">{a.reason ?? 'Unavailable'}</span>
                          </PromptInputSelectItem>
                        </div>
                      </TooltipTrigger>
                      {a.reason && <TooltipContent>{a.reason}</TooltipContent>}
                    </Tooltip>
                  ),
                )}
              </PromptInputSelectContent>
            </PromptInputSelect>
            {noAgent && (
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                Not configured
                <Link href="/settings" className="underline underline-offset-2 hover:text-foreground">
                  Settings
                </Link>
              </span>
            )}
            <PromptInputSelect value={effectiveModel ?? ''} onValueChange={setModel} disabled={models.length === 0}>
              <PromptInputSelectTrigger size="sm" aria-label="Model">
                <PromptInputSelectValue placeholder="Model" />
              </PromptInputSelectTrigger>
              <PromptInputSelectContent>
                {models.map((m) => (
                  <PromptInputSelectItem key={m.id} value={m.id}>
                    {m.label}
                  </PromptInputSelectItem>
                ))}
              </PromptInputSelectContent>
            </PromptInputSelect>
            <PromptInputSelect
              value={permissions ?? 'auto'}
              onValueChange={(v) => setPermissions(v as PermissionPolicy)}
            >
              <PromptInputSelectTrigger size="sm" aria-label="Permissions">
                <PromptInputSelectValue />
              </PromptInputSelectTrigger>
              <PromptInputSelectContent>
                <PromptInputSelectItem value="auto">Auto</PromptInputSelectItem>
                <PromptInputSelectItem value="ask">Ask</PromptInputSelectItem>
              </PromptInputSelectContent>
            </PromptInputSelect>
            <AttachButton />
          </PromptInputTools>
          <Button type="submit" size="sm" className="shrink-0" disabled={!canSubmit}>
            Start
            <kbd className="ml-1 font-sans text-xs text-primary-foreground/70">{modKey}+Enter</kbd>
          </Button>
        </PromptInputFooter>
      </PromptInput>
      {/* Outside the PromptInput: forms cannot nest. */}
      {creatingProject && (
        <NewProjectForm
          className="rounded-md border p-4"
          onCreated={(p) => {
            setCreatingProject(false)
            setProjectId(p.id)
          }}
          onCancel={() => setCreatingProject(false)}
        />
      )}
    </div>
  )
}

const subscribeNever = (): (() => void) => () => {}
const isApple = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform)

/** Server-rendered as Ctrl; hydration swaps in Cmd on Apple platforms without a mismatch. */
function useModKey(): string {
  return useSyncExternalStore(subscribeNever, () => (isApple() ? 'Cmd' : 'Ctrl'), () => 'Ctrl')
}

function AttachButton() {
  const attachments = usePromptInputAttachments()
  return (
    <PromptInputButton onClick={attachments.openFileDialog} aria-label="Attach image" tooltip="Attach image">
      <ImageIcon />
    </PromptInputButton>
  )
}

/** Enter inserts a newline; Cmd/Ctrl+Enter submits. Pasted images become attachments. */
function ComposerTextarea({ disabled, canSubmit }: { disabled: boolean; canSubmit: boolean }) {
  const { textInput } = usePromptInputController()
  const attachments = usePromptInputAttachments()

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (canSubmit) e.currentTarget.form?.requestSubmit()
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>): void {
    const files: File[] = []
    for (const item of e.clipboardData.items) {
      if (item.kind === 'file') {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      attachments.add(files)
    }
  }

  return (
    <InputGroupTextarea
      name="message"
      autoFocus
      disabled={disabled}
      value={textInput.value}
      onChange={(e) => textInput.setInput(e.currentTarget.value)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      placeholder="Describe the task"
      className="field-sizing-content max-h-[50vh] min-h-40 text-base"
    />
  )
}
