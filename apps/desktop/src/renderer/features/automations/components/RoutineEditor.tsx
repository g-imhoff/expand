import { useEffect, useState } from "react"
import type { Catalog } from "@expand/contracts/automation"
import type { PreviewOutcome, RoutineHead } from "@expand/contracts/rpc/automation-schemas"
import { Input } from "@expand/desktop/renderer/components/ui/input"
import { Label } from "@expand/desktop/renderer/components/ui/label"
import { RoutineTestPanel, type PreviewRequestInput } from "@expand/desktop/renderer/features/automations/components/RoutineTestPanel"
import {
  useAutomationCatalog,
  useRoutinePreview,
  useRoutineRecord,
  useRoutineSave,
  useRoutineStatus
} from "@expand/desktop/renderer/features/automations/data/use-routine-editor"
import { useCredentialStatuses } from "@expand/desktop/renderer/features/automations/data/use-integrations"
import {
  abstainChoice,
  actionArgumentNames,
  actionForKey,
  blankEditorForm,
  blankTemplateKey,
  catalogActions,
  catalogTemplates,
  catalogTriggers,
  definitionKeyOf,
  formFromRoutine,
  formFromTemplate,
  headForRoutine,
  integrationForTrigger,
  routineIdProblem,
  routineWriteFromForm,
  triggerForKey,
  triggeredOutcomeId,
  triggerIsGithubIssue,
  unmatchedBehaviorOptions,
  type EditorCategoryInput,
  type EditorStepInput,
  type RoutineEditorForm
} from "@expand/desktop/renderer/features/automations/model/routine-editor"
import { describeAutomationError } from "@expand/desktop/renderer/features/automations/model/run-history"
import { FeatureCredentialSeam } from "@expand/desktop/renderer/features/settings/components/FeatureCredentialSeam"
import {
  automationScopeForProject,
  githubCredentialId
} from "@expand/desktop/renderer/features/automations/model/integration-messages"

export interface RoutineEditorProps {
  readonly projectId: string
  readonly routineId: string | undefined
}

export const RoutineEditor = ({ projectId, routineId }: RoutineEditorProps) => {
  const catalogQuery = useAutomationCatalog()
  const [createdId, setCreatedId] = useState<string | undefined>(undefined)
  const editingId = routineId ?? createdId
  const recordQuery = useRoutineRecord(projectId, editingId)
  const saveMutation = useRoutineSave(projectId)
  const statusMutation = useRoutineStatus(projectId)
  const previewMutation = useRoutinePreview(projectId)
  const [form, setForm] = useState<RoutineEditorForm>(blankEditorForm)
  const [initKey, setInitKey] = useState<string | undefined>(undefined)
  const [head, setHead] = useState<RoutineHead | undefined>(undefined)
  const [savedMessage, setSavedMessage] = useState<string | undefined>(undefined)
  const [previewOutcome, setPreviewOutcome] = useState<PreviewOutcome | undefined>(undefined)
  const catalog = catalogQuery.catalog

  useEffect(() => {
    const record = recordQuery.record
    if (editingId === undefined || record === undefined) return
    const key = `${record.routineId}:${record.head.revision}`
    if (initKey === key) return
    setInitKey(key)
    setForm(formFromRoutine(record))
    setHead(headForRoutine(record))
  }, [editingId, recordQuery.record, initKey])

  useEffect(() => {
    setPreviewOutcome(undefined)
    previewMutation.reset()
  }, [form])

  if (catalogQuery.unavailable || recordQuery.unavailable) {
    return <p className="mt-2 text-sm text-muted-foreground">Automation services are unavailable in this session.</p>
  }
  if (catalogQuery.isLoading && catalog === undefined) {
    return <p className="mt-2 text-sm text-muted-foreground">Loading routine editor…</p>
  }
  if (catalogQuery.error !== undefined && catalog === undefined) {
    return (
      <div>
        <p role="alert" className="mt-2 text-sm text-red-600">{describeAutomationError(catalogQuery.error)}</p>
        <button type="button" onClick={catalogQuery.retry} className="mt-2 text-sm underline">Retry</button>
      </div>
    )
  }
  if (catalog === undefined) {
    return <p className="mt-2 text-sm text-muted-foreground">Loading routine editor…</p>
  }
  const triggers = catalogTriggers(catalog)
  if (triggers.length === 0) {
    return <p className="mt-2 text-sm text-muted-foreground">No triggers are registered on the backend yet.</p>
  }
  if (editingId !== undefined) {
    if ((recordQuery.isLoading && recordQuery.record === undefined) || (recordQuery.record === undefined && recordQuery.error === undefined)) {
      return <p className="mt-2 text-sm text-muted-foreground">Loading routine…</p>
    }
    if (recordQuery.error !== undefined && recordQuery.record === undefined) {
      return (
        <div>
          <p role="alert" className="mt-2 text-sm text-red-600">{describeAutomationError(recordQuery.error)}</p>
          <button type="button" onClick={recordQuery.reload} className="mt-2 text-sm underline">Retry</button>
        </div>
      )
    }
    if (recordQuery.record === undefined) {
      return <p className="mt-2 text-sm text-muted-foreground">Routine {editingId} does not exist.</p>
    }
  }

  const github = triggerIsGithubIssue(catalog, form)
  const idProblem = editingId === undefined ? routineIdProblem(form) : undefined
  const { write, problems } = routineWriteFromForm(form, catalog)
  const blocking = idProblem === undefined ? problems : [idProblem, ...problems]
  const canSave = write !== undefined && blocking.length === 0 && !saveMutation.isPending
  const previewReady = write !== undefined && blocking.length === 0 && form.useDecision && !previewMutation.isPending
  const previewBlocked = !form.useDecision
    ? "Enable the Jev decision step to run a preview."
    : blocking.length > 0
      ? "Fix the form problems above to run a preview."
      : undefined

  const updateForm = (next: RoutineEditorForm) => {
    setForm(next)
    setSavedMessage(undefined)
  }

  const applyTemplate = (key: string) => {
    if (key === blankTemplateKey) {
      updateForm({ ...form, templateKey: key })
      return
    }
    const template = catalogTemplates(catalog).find((entry) => definitionKeyOf(entry.definition) === key)
    if (template === undefined) return
    const loaded = formFromTemplate(template)
    updateForm({ ...loaded, routineId: form.routineId, integrationId: form.integrationId, owner: form.owner, repo: form.repo })
  }

  const chooseTrigger = (key: string) => {
    updateForm({ ...form, triggerKey: key, templateKey: blankTemplateKey })
  }

  const save = () => {
    if (write === undefined) return
    if (editingId === undefined) {
      const id = form.routineId.trim()
      if (id.length === 0) return
      saveMutation.mutate({ routineId: id, mode: "create", write }, {
        onSuccess: (result) => {
          setCreatedId(id)
          setSavedMessage(`Created revision ${result.revision}.`)
          recordQuery.reload()
        }
      })
      return
    }
    saveMutation.mutate({ routineId: editingId, mode: "edit", write }, {
      onSuccess: (result) => {
        setSavedMessage(`Saved revision ${result.revision}.`)
        recordQuery.reload()
      }
    })
  }

  const toggleStatus = () => {
    if (editingId === undefined || head === undefined) return
    if (saveMutation.isPending || recordQuery.isLoading) return
    if (head.status !== "enabled" && head.status !== "paused") return
    const next = head.status === "enabled" ? "paused" : "enabled"
    statusMutation.mutate({ routineId: editingId, expectedVersion: head.version, next }, {
      onSuccess: (result) => setHead(result)
    })
  }

  const runPreview = (input: PreviewRequestInput) => {
    if (write === undefined) return
    previewMutation.mutate({
      inlineRoutineId: editingId ?? (form.routineId.trim() === "" ? "preview" : form.routineId.trim()),
      write,
      issueNumber: Number(input.issueNumber),
      title: input.title,
      body: input.body.trim() === "" ? undefined : input.body,
      outcomeId: input.outcomeChoice === abstainChoice ? undefined : input.outcomeChoice,
      abstainReason: input.abstainReason
    }, {
      onSuccess: (result) => setPreviewOutcome(result)
    })
  }

  return (
    <div>
      <section aria-label="Routine">
        <h2 className="text-lg font-semibold">Routine</h2>
        <div className="mt-3 max-w-md">
          <Label htmlFor="routine-editor-id">Routine id</Label>
          <Input
            id="routine-editor-id"
            value={form.routineId}
            onChange={(event) => updateForm({ ...form, routineId: event.target.value })}
            disabled={editingId !== undefined}
            autoComplete="off"
          />
        </div>
      </section>
      <section aria-label="Template" className="mt-8">
        <h2 className="text-lg font-semibold">Template</h2>
        <p className="mt-2 text-sm text-muted-foreground">Templates fill the form below and stay fully editable.</p>
        <div className="mt-3 max-w-md">
          <Label htmlFor="routine-editor-template">Start from a template</Label>
          <select
            id="routine-editor-template"
            value={form.templateKey}
            onChange={(event) => applyTemplate(event.target.value)}
            className="min-h-9 w-full rounded border px-2 text-sm"
          >
            <option value={blankTemplateKey}>Blank routine</option>
            {catalogTemplates(catalog).map((template) => (
              <option key={definitionKeyOf(template.definition)} value={definitionKeyOf(template.definition)}>
                {template.title}
              </option>
            ))}
          </select>
        </div>
      </section>
      <section aria-label="Trigger" className="mt-8">
        <h2 className="text-lg font-semibold">Trigger</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Exactly one trigger starts a routine. No loops or branching: the routine runs the trigger,
          an optional Jev decision, then the actions for the chosen outcome.
        </p>
        <div className="mt-3 max-w-md">
          <Label htmlFor="routine-editor-trigger">Trigger</Label>
          <select
            id="routine-editor-trigger"
            value={form.triggerKey}
            onChange={(event) => chooseTrigger(event.target.value)}
            className="min-h-9 w-full rounded border px-2 text-sm"
          >
            <option value="">Select a trigger</option>
            {triggers.map((trigger) => (
              <option key={definitionKeyOf(trigger.definition)} value={definitionKeyOf(trigger.definition)}>
                {trigger.title} ({trigger.definition.id} v{trigger.definition.version})
              </option>
            ))}
          </select>
        </div>
      </section>
      <IntegrationSection form={form} catalog={catalog} projectId={projectId} onChange={updateForm} />
      <section aria-label="Jev decision" className="mt-8">
        <h2 className="text-lg font-semibold">Jev decision</h2>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.useDecision}
            onChange={(event) => updateForm({
              ...form,
              useDecision: event.target.checked,
              templateKey: event.target.checked ? form.templateKey : blankTemplateKey
            })}
          />
          Classify with Jev
        </label>
        {form.useDecision ? (
          <div className="mt-3 flex flex-col gap-4">
            {form.categories.map((category, index) => (
              <CategoryEditor
                key={index}
                catalog={catalog}
                category={category}
                index={index}
                github={github}
                total={form.categories.length}
                onChange={(patch) => updateForm({
                  ...form,
                  categories: form.categories.map((entry, position) => position === index ? { ...entry, ...patch } : entry)
                })}
                onRemove={() => updateForm({ ...form, categories: form.categories.filter((_, position) => position !== index) })}
                onStepChange={(stepIndex, patch) => updateForm({
                  ...form,
                  categories: form.categories.map((entry, position) => position === index
                    ? { ...entry, steps: entry.steps.map((step, current) => current === stepIndex ? { ...step, ...patch } : step) }
                    : entry)
                })}
                onStepRemove={(stepIndex) => updateForm({
                  ...form,
                  categories: form.categories.map((entry, position) => position === index
                    ? { ...entry, steps: entry.steps.filter((_, current) => current !== stepIndex) }
                    : entry)
                })}
                onStepAdd={() => {
                  const actions = catalogActions(catalog)
                  const first = actions[0]
                  updateForm({
                    ...form,
                    categories: form.categories.map((entry, position) => position === index
                      ? { ...entry, steps: [...entry.steps, { actionKey: first === undefined ? "" : definitionKeyOf(first.definition), values: {} }] }
                      : entry)
                  })
                }}
              />
            ))}
            <div>
              <button type="button" onClick={() => updateForm({ ...form, categories: [...form.categories, { name: "", label: "", steps: [] }] })} className="min-h-9 rounded border px-3 text-sm">
                Add category
              </button>
            </div>
          </div>
        ) : (
          <TriggerStepsEditor catalog={catalog} form={form} github={github} onChange={updateForm} />
        )}
      </section>
      <section aria-label="Unmatched input" className="mt-8">
        <h2 className="text-lg font-semibold">Unmatched input</h2>
        <p className="mt-2 text-sm text-muted-foreground">Unmatched input runs no actions.</p>
        <div className="mt-3 max-w-md">
          <Label htmlFor="routine-editor-unmatched">When nothing matches</Label>
          <select
            id="routine-editor-unmatched"
            value={form.unmatchedBehavior}
            onChange={(event) => updateForm({ ...form, unmatchedBehavior: event.target.value })}
            className="min-h-9 w-full rounded border px-2 text-sm"
          >
            {unmatchedBehaviorOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
      </section>
      <section aria-label="Notifications" className="mt-8">
        <h2 className="text-lg font-semibold">Notifications</h2>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.notifyOnMatch}
            onChange={(event) => updateForm({ ...form, notifyOnMatch: event.target.checked })}
          />
          Notify on match
        </label>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.notifyOnNoMatch}
            onChange={(event) => updateForm({ ...form, notifyOnNoMatch: event.target.checked })}
          />
          Notify when nothing matches
        </label>
      </section>
      {head !== undefined && (
        <section aria-label="Status" className="mt-8">
          <h2 className="text-lg font-semibold">Status</h2>
          <p className="mt-2 text-sm">Status: {head.status} (revision {head.revision})</p>
          {(head.status === "enabled" || head.status === "paused") && (
            <button
              type="button"
              onClick={toggleStatus}
              disabled={statusMutation.isPending || saveMutation.isPending || recordQuery.isLoading}
              className="mt-2 min-h-9 rounded border px-3 text-sm disabled:opacity-50"
            >
              {statusMutation.isPending ? "Updating…" : head.status === "enabled" ? "Pause" : "Enable"}
            </button>
          )}
          {statusMutation.error !== undefined && (
            <p role="alert" className="mt-2 text-sm text-red-600">{describeAutomationError(statusMutation.error)}</p>
          )}
        </section>
      )}
      <section aria-label="Save" className="mt-8">
        <h2 className="text-lg font-semibold">Save</h2>
        {blocking.length > 0 && (
          <ul className="mt-2 list-disc pl-5 text-sm text-muted-foreground">
            {blocking.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className="mt-3 min-h-9 rounded border px-3 text-sm disabled:opacity-50"
        >
          {saveMutation.isPending ? "Saving…" : editingId === undefined ? "Create routine" : "Save changes"}
        </button>
        {saveMutation.error !== undefined && (
          <p role="alert" className="mt-2 text-sm text-red-600">{describeAutomationError(saveMutation.error)}</p>
        )}
        {savedMessage !== undefined && (
          <p role="status" className="mt-2 text-sm text-muted-foreground">{savedMessage}</p>
        )}
      </section>
      <RoutineTestPanel
        form={form}
        canPreview={previewReady}
        blockedReason={previewBlocked}
        isPending={previewMutation.isPending}
        outcome={previewOutcome}
        error={previewMutation.error}
        onPreview={runPreview}
      />
    </div>
  )
}

const IntegrationSection = ({
  form,
  catalog,
  projectId,
  onChange
}: {
  readonly form: RoutineEditorForm
  readonly catalog: Catalog
  readonly projectId: string
  readonly onChange: (form: RoutineEditorForm) => void
}) => {
  const credentials = useCredentialStatuses(automationScopeForProject(projectId))
  const trigger = form.triggerKey === "" ? undefined : triggerForKey(catalog, form.triggerKey)
  const integration = trigger === undefined ? undefined : integrationForTrigger(catalog, trigger)
  const showRepository = trigger?.definition.id === "github:issue-opened" || integration?.definition.id === "github:integration"
  const githubConnected = credentials.credentials?.some((credential) => credential.credentialId === githubCredentialId && credential.configured) ?? false
  return (
    <section aria-label="Integration" className="mt-8">
      <h2 className="text-lg font-semibold">Integration</h2>
      {integration !== undefined && (
        <p className="mt-2 text-sm text-muted-foreground">
          Runs on {integration.title} ({integration.definition.id} v{integration.definition.version}).
        </p>
      )}
      <div className="mt-3 grid max-w-md gap-3">
        <div>
          <Label htmlFor="routine-editor-integration">Integration instance id</Label>
          <Input
            id="routine-editor-integration"
            value={form.integrationId}
            onChange={(event) => onChange({ ...form, integrationId: event.target.value })}
            autoComplete="off"
          />
        </div>
        {showRepository && (
          <FeatureCredentialSeam
            seam={{ connected: githubConnected, featureName: "GitHub", returnTarget: "routine-editor" }}
            onOpenSettings={() => {
              window.location.hash = "#/settings"
            }}
          >
            {(disabled) => (
              <>
                <div>
                  <Label htmlFor="routine-editor-owner">Repository owner</Label>
                  <Input
                    id="routine-editor-owner"
                    value={form.owner}
                    disabled={disabled}
                    onChange={(event) => onChange({ ...form, owner: event.target.value })}
                    autoComplete="off"
                  />
                </div>
                <div>
                  <Label htmlFor="routine-editor-repo">Repository name</Label>
                  <Input
                    id="routine-editor-repo"
                    value={form.repo}
                    disabled={disabled}
                    onChange={(event) => onChange({ ...form, repo: event.target.value })}
                    autoComplete="off"
                  />
                </div>
              </>
            )}
          </FeatureCredentialSeam>
        )}
      </div>
    </section>
  )
}

const CategoryEditor = ({
  catalog,
  category,
  index,
  github,
  total,
  onChange,
  onRemove,
  onStepChange,
  onStepRemove,
  onStepAdd
}: {
  readonly catalog: Catalog
  readonly category: EditorCategoryInput
  readonly index: number
  readonly github: boolean
  readonly total: number
  readonly onChange: (patch: Partial<EditorCategoryInput>) => void
  readonly onRemove: () => void
  readonly onStepChange: (stepIndex: number, patch: Partial<EditorStepInput>) => void
  readonly onStepRemove: (stepIndex: number) => void
  readonly onStepAdd: () => void
}) => (
  <div className="rounded border px-3 py-2">
    <div className="grid max-w-md gap-3">
      <div>
        <Label htmlFor={`routine-editor-category-${index}-name`}>Category name</Label>
        <Input
          id={`routine-editor-category-${index}-name`}
          value={category.name}
          onChange={(event) => onChange({ name: event.target.value })}
          autoComplete="off"
        />
      </div>
      <div>
        <Label htmlFor={`routine-editor-category-${index}-label`}>{github ? "Label" : "Description"}</Label>
        <Input
          id={`routine-editor-category-${index}-label`}
          value={category.label}
          onChange={(event) => onChange({ label: event.target.value })}
          autoComplete="off"
        />
      </div>
    </div>
    <div className="mt-3">
      <h3 className="text-sm font-medium">Actions for {category.name.trim() === "" ? `category ${index + 1}` : category.name.trim()}</h3>
      {category.steps.map((step, stepIndex) => (
        <StepEditor
          key={stepIndex}
          catalog={catalog}
          step={step}
          categoryLabel={category.label}
          github={github}
          actionLabel={`Action for ${category.name.trim() === "" ? `category ${index + 1}` : category.name.trim()}`}
          valuesPrefix={`Argument for ${category.name.trim() === "" ? `category ${index + 1}` : category.name.trim()}`}
          idPrefix={`routine-editor-category-${index}-step-${stepIndex}`}
          onChange={(patch) => onStepChange(stepIndex, patch)}
          onRemove={() => onStepRemove(stepIndex)}
        />
      ))}
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={onStepAdd} className="min-h-9 rounded border px-3 text-sm">
          Add action
        </button>
        {total > 1 && (
          <button type="button" onClick={onRemove} className="min-h-9 rounded border px-3 text-sm">
            Remove category
          </button>
        )}
      </div>
    </div>
  </div>
)

const TriggerStepsEditor = ({
  catalog,
  form,
  github,
  onChange
}: {
  readonly catalog: Catalog
  readonly form: RoutineEditorForm
  readonly github: boolean
  readonly onChange: (form: RoutineEditorForm) => void
}) => {
  const entry = form.categories.find((category) => category.name.trim() === triggeredOutcomeId)
  const steps = entry === undefined ? [] : entry.steps
  const setSteps = (next: ReadonlyArray<EditorStepInput>) => {
    const fallback: EditorCategoryInput = { name: triggeredOutcomeId, label: "", steps: next }
    if (entry === undefined) {
      onChange({ ...form, categories: [...form.categories, fallback] })
      return
    }
    onChange({ ...form, categories: form.categories.map((category) => category === entry ? { ...category, steps: next } : category) })
  }
  return (
    <div className="mt-3">
      <p className="text-sm text-muted-foreground">Actions run for every trigger without classification.</p>
      {steps.map((step, stepIndex) => (
        <StepEditor
          key={stepIndex}
          catalog={catalog}
          step={step}
          categoryLabel=""
          github={github}
          actionLabel="Action on trigger"
          valuesPrefix="Argument on trigger"
          idPrefix={`routine-editor-trigger-step-${stepIndex}`}
          onChange={(patch) => setSteps(steps.map((current, position) => position === stepIndex ? { ...current, ...patch } : current))}
          onRemove={() => setSteps(steps.filter((_, position) => position !== stepIndex))}
        />
      ))}
      <button
        type="button"
        onClick={() => {
          const actions = catalogActions(catalog)
          const first = actions[0]
          setSteps([...steps, { actionKey: first === undefined ? "" : definitionKeyOf(first.definition), values: {} }])
        }}
        className="mt-2 min-h-9 rounded border px-3 text-sm"
      >
        Add action
      </button>
    </div>
  )
}

const StepEditor = ({
  catalog,
  step,
  categoryLabel,
  github,
  actionLabel,
  valuesPrefix,
  idPrefix,
  onChange,
  onRemove
}: {
  readonly catalog: Catalog
  readonly step: EditorStepInput
  readonly categoryLabel: string
  readonly github: boolean
  readonly actionLabel: string
  readonly valuesPrefix: string
  readonly idPrefix: string
  readonly onChange: (patch: Partial<EditorStepInput>) => void
  readonly onRemove: () => void
}) => {
  const action = step.actionKey === "" ? undefined : actionForKey(catalog, step.actionKey)
  const names = action === undefined ? [] : actionArgumentNames(action)
  const editable = names.filter((argument) =>
    argument !== "issueNumber" && !(argument === "label" && github && action?.definition.id === "github:label-issue"))
  return (
    <div className="mt-2 rounded border px-3 py-2">
      <div className="max-w-md">
        <Label htmlFor={`${idPrefix}-action`}>{actionLabel}</Label>
        <select
          id={`${idPrefix}-action`}
          value={step.actionKey}
          onChange={(event) => onChange({ actionKey: event.target.value, values: {} })}
          className="min-h-9 w-full rounded border px-2 text-sm"
        >
          <option value="">Select an action</option>
          {catalogActions(catalog).map((entry) => (
            <option key={definitionKeyOf(entry.definition)} value={definitionKeyOf(entry.definition)}>
              {entry.title} ({entry.definition.id} v{entry.definition.version})
            </option>
          ))}
        </select>
      </div>
      {names.includes("issueNumber") && (
        <p className="mt-2 text-sm text-muted-foreground">Issue number comes from the trigger.</p>
      )}
      {github && action?.definition.id === "github:label-issue" && (
        <p className="mt-2 text-sm text-muted-foreground">
          Labels with “{categoryLabel === "" ? step.values["label"] ?? "" : categoryLabel}”.
        </p>
      )}
      {editable.map((argument) => (
        <div key={argument} className="mt-2 max-w-md">
          <Label htmlFor={`${idPrefix}-arg-${argument}`}>{valuesPrefix} {argument}</Label>
          <Input
            id={`${idPrefix}-arg-${argument}`}
            value={step.values[argument] ?? ""}
            onChange={(event) => onChange({ values: { ...step.values, [argument]: event.target.value } })}
            autoComplete="off"
          />
        </div>
      ))}
      <button type="button" onClick={onRemove} className="mt-2 min-h-9 rounded border px-3 text-sm">
        Remove action
      </button>
    </div>
  )
}
