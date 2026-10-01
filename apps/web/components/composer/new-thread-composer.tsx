'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useEffect, useMemo, useState, useSyncExternalStore, type ClipboardEvent, type KeyboardEvent } from 'react'
import { DEFAULT_MODEL, DEFAULT_MODELS, DEFAULT_PERMISSIONS, PERMISSION_MODES, type AgentKind, type PermissionMode } from '@valet/shared'
import { ImageIcon } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage } from '@/lib/api'
import { useAccounts, useAgents, useBranches, useSettings } from '@/lib/hooks'
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
import { SelectGroup, SelectLabel } from '@/components/ui/select'
import { useAppData } from '@/components/app/data-provider'
import { AttachmentStrip } from '@/components/composer/attachments'
import { DropOverlay } from '@/components/composer/drop-overlay'
import { cn } from '@/lib/utils'
import { NewProjectForm } from '@/components/composer/new-project-form'
import { ProjectPicker } from '@/components/composer/project-picker'

/** Text-only controls inside the tab; the tab supplies the surface. */
const TAB_TRIGGER = 'h-7 border-0 bg-transparent px-2 shadow-none hover:bg-background/70 dark:bg-transparent dark:hover:bg-background/40'

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
  const [permissions, setPermissions] = useState<PermissionMode | null>(null)
  const [accountId, setAccountId] = useState<string | null>(null)
  const { data: accountsData } = useAccounts()
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
    if (projectId || projects.length === 0) return
    setProjectId(projects[0]?.id ?? null)
  }, [projectId, projects])

  const agentInfo = agents.find((a) => a.id === agent) ?? null
  const noAgent = agents.length > 0 && !agents.some((a) => a.available)
  const models = useMemo(() => {
    if (agentInfo && agentInfo.models.length > 0) return agentInfo.models
    return agent ? DEFAULT_MODELS[agent] : []
  }, [agentInfo, agent])
  // The first candidate the list actually contains: the pick, the settings default, then core's resolved default.
  const effectiveModel =
    [model, agent && settings?.defaultModel[agent], agentInfo?.defaultModel, agent && DEFAULT_MODEL[agent]].find(
      (id): id is string => !!id && models.some((m) => m.id === id),
    ) ??
    models[0]?.id ??
    null
  // Every agent's models in one list; picking one sets the agent and the model together.
  const modelsByAgent = useMemo(
    () => agents.map((a) => ({ agent: a, models: a.models.length > 0 ? a.models : DEFAULT_MODELS[a.id] })),
    [agents],
  )
  const pickModel = (value: string): void => {
    const [nextAgent, ...rest] = value.split(':')
    if (nextAgent !== 'claude' && nextAgent !== 'codex') return
    if (nextAgent !== agent) {
      setPermissions(null)
      setAccountId(null)
    }
    setAgent(nextAgent)
    setModel(rest.join(':'))
  }
  const accounts = useMemo(() => (accountsData?.accounts ?? []).filter((a) => a.agent === agent), [accountsData, agent])
  // The pick, then the settings default, then the agent's oldest account.
  const effectiveAccount =
    [accountId, agent && settings?.defaultAccount[agent], accounts[0]?.id].find((id): id is string => !!id && accounts.some((a) => a.id === id)) ?? null
  const permissionModes = agent ? PERMISSION_MODES[agent] : []
  // The pick, then the settings default, then the built-in default; each agent has its own modes.
  const effectivePermissions =
    [permissions, agent && settings?.defaultPermissions[agent], agent && DEFAULT_PERMISSIONS[agent]].find(
      (id): id is string => !!id && permissionModes.some((m) => m.id === id),
    ) ?? null

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
        ...(effectivePermissions ? { permissions: effectivePermissions } : {}),
        ...(effectiveAccount ? { accountId: effectiveAccount } : {}),
        baseBranch: effectiveBranch,
      })
      upsertThread({ ...thread, projectName: project.name, diffStats: null, mcpServers: 0 })
      router.push(`/threads/${thread.id}`)
    } catch (err) {
      toast.error(errorMessage(err))
      setBusy(false)
      throw err
    }
  }

  return (
    <div className="flex flex-col">
      {/* Folder tab on the box: where the thread runs. Project left, branch right. */}
      <div className="mx-3 flex items-center justify-between gap-2 rounded-t-lg border border-b-0 border-input bg-muted/60 px-1.5 py-1">
        <ProjectPicker
          projects={projects}
          value={projectId}
          onChange={setProjectId}
          creating={creatingProject}
          onCreatingChange={setCreatingProject}
          size="sm"
          triggerClassName={cn(TAB_TRIGGER, 'font-medium')}
        />
        {creatingProject ? (
          <span className="px-2 text-xs text-muted-foreground">New project</span>
        ) : (
          <PromptInputSelect value={effectiveBranch ?? ''} onValueChange={setBaseBranch} disabled={!project}>
            <PromptInputSelectTrigger size="sm" aria-label="Base branch" className={cn(TAB_TRIGGER, 'font-mono text-xs')}>
              <PromptInputSelectValue placeholder="Branch" />
            </PromptInputSelectTrigger>
            <PromptInputSelectContent position="popper" align="end" sideOffset={6}>
              {branches.map((b) => (
                <PromptInputSelectItem key={b} value={b} className="font-mono text-xs">
                  {b}
                </PromptInputSelectItem>
              ))}
            </PromptInputSelectContent>
          </PromptInputSelect>
        )}
      </div>
      {creatingProject ? (
        <NewProjectForm
          className="rounded-lg border bg-background p-3"
          onCreated={(p) => {
            setCreatingProject(false)
            setProjectId(p.id)
          }}
          onCancel={() => setCreatingProject(false)}
        />
      ) : (
      <PromptInput onSubmit={submit} accept="image/*" multiple globalDrop className="flex flex-col">
        <DropOverlay />
        <AttachmentStrip />
        <ComposerTextarea disabled={busy} canSubmit={canSubmit} />
        <PromptInputFooter className="flex-nowrap items-center gap-2">
          <PromptInputTools className="min-w-0 flex-nowrap gap-1">
            <AttachButton />
            <PromptInputSelect value={effectivePermissions ?? ''} onValueChange={setPermissions} disabled={permissionModes.length === 0}>
              <PromptInputSelectTrigger size="sm" aria-label="Permissions">
                <PromptInputSelectValue placeholder="Permissions" />
              </PromptInputSelectTrigger>
              <PromptInputSelectContent position="popper" align="start">
                {permissionModes.map((m) => (
                  <PromptInputSelectItem key={m.id} value={m.id}>
                    {m.label}
                  </PromptInputSelectItem>
                ))}
              </PromptInputSelectContent>
            </PromptInputSelect>
          </PromptInputTools>
          <div className="flex min-w-0 items-center gap-2">
            <PromptInputSelect value={agent && effectiveModel ? `${agent}:${effectiveModel}` : ''} onValueChange={pickModel} disabled={modelsByAgent.length === 0}>
              <PromptInputSelectTrigger size="sm" aria-label="Model">
                <PromptInputSelectValue placeholder="Model" />
              </PromptInputSelectTrigger>
              <PromptInputSelectContent position="popper" align="start">
                {modelsByAgent.map(({ agent: a, models: list }) => (
                  <SelectGroup key={a.id}>
                    <SelectLabel>{a.label}</SelectLabel>
                    {a.available ? (
                      list.map((m) => (
                        <PromptInputSelectItem key={`${a.id}:${m.id}`} value={`${a.id}:${m.id}`}>
                          {m.label}
                        </PromptInputSelectItem>
                      ))
                    ) : (
                      <PromptInputSelectItem value={`${a.id}:`} disabled>
                        {a.reason ?? 'Unavailable'}
                      </PromptInputSelectItem>
                    )}
                  </SelectGroup>
                ))}
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
            {accounts.length > 1 && (
              <PromptInputSelect value={effectiveAccount ?? ''} onValueChange={setAccountId}>
                <PromptInputSelectTrigger size="sm" aria-label="Account">
                  <PromptInputSelectValue placeholder="Account" />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent position="popper" align="end">
                  {accounts.map((a) => (
                    <PromptInputSelectItem key={a.id} value={a.id}>
                      {a.name}
                    </PromptInputSelectItem>
                  ))}
                </PromptInputSelectContent>
              </PromptInputSelect>
            )}
            <Button type="submit" size="sm" className="shrink-0" disabled={!canSubmit}>
              Start
              <kbd className="ml-1 font-sans text-xs text-primary-foreground/70">{modKey}+Enter</kbd>
            </Button>
          </div>
        </PromptInputFooter>
      </PromptInput>
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
