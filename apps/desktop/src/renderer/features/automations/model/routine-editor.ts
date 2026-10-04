import type {
  ActionDescriptor,
  Catalog,
  IntegrationDescriptor,
  JevDecisionResult,
  RoutineDescriptor,
  TriggerDescriptor
} from "@expand/contracts/automation"
import type { RoutineHead, RoutineRecord } from "@expand/contracts/rpc/automation-schemas"
import type { DefinitionReference, IntegrationConfiguration, JsonValue, ProcessDefinition } from "@expand/contracts/automation"

export interface RoutineWrite {
  readonly template?: DefinitionReference
  readonly configuration: JsonValue
  readonly integrations: ReadonlyArray<IntegrationConfiguration>
  readonly process: ProcessDefinition
}

export interface EditorStepInput {
  readonly actionKey: string
  readonly values: { readonly [argument: string]: string }
}

export interface EditorCategoryInput {
  readonly name: string
  readonly label: string
  readonly steps: ReadonlyArray<EditorStepInput>
}

export interface RoutineEditorForm {
  readonly routineId: string
  readonly templateKey: string
  readonly triggerKey: string
  readonly integrationId: string
  readonly owner: string
  readonly repo: string
  readonly useDecision: boolean
  readonly categories: ReadonlyArray<EditorCategoryInput>
  readonly unmatchedBehavior: string
  readonly notifyOnMatch: boolean
  readonly notifyOnNoMatch: boolean
}

export interface RoutineWriteResult {
  readonly write: RoutineWrite | undefined
  readonly problems: ReadonlyArray<string>
}

export interface UnmatchedBehaviorOption {
  readonly value: string
  readonly label: string
}

export const blankTemplateKey = "blank"

export const leaveUnchangedBehavior = "leave-unchanged"

export const triggeredOutcomeId = "triggered"

export const abstainChoice = "abstain"

export const unmatchedBehaviorOptions: ReadonlyArray<UnmatchedBehaviorOption> = [
  { value: leaveUnchangedBehavior, label: "Leave unchanged" }
]

export const blankEditorForm = (): RoutineEditorForm => ({
  routineId: "",
  templateKey: blankTemplateKey,
  triggerKey: "",
  integrationId: "github",
  owner: "",
  repo: "",
  useDecision: true,
  categories: [{ name: "bug", label: "type: bug", steps: [] }],
  unmatchedBehavior: leaveUnchangedBehavior,
  notifyOnMatch: true,
  notifyOnNoMatch: true
})

export const catalogTriggers = (catalog: Catalog): ReadonlyArray<TriggerDescriptor> =>
  catalog.definitions.filter((definition): definition is TriggerDescriptor => definition.kind === "trigger")

export const catalogActions = (catalog: Catalog): ReadonlyArray<ActionDescriptor> =>
  catalog.definitions.filter((definition): definition is ActionDescriptor => definition.kind === "action")

export const catalogTemplates = (catalog: Catalog): ReadonlyArray<RoutineDescriptor> =>
  catalog.definitions.filter((definition): definition is RoutineDescriptor => definition.kind === "routine-template")

export const triggerForKey = (catalog: Catalog, key: string): TriggerDescriptor | undefined =>
  catalogTriggers(catalog).find((trigger) => definitionKeyOf(trigger.definition) === key)

export const actionForKey = (catalog: Catalog, key: string): ActionDescriptor | undefined =>
  catalogActions(catalog).find((action) => definitionKeyOf(action.definition) === key)

export const templateForKey = (catalog: Catalog, key: string): RoutineDescriptor | undefined =>
  catalogTemplates(catalog).find((template) => definitionKeyOf(template.definition) === key)

export const integrationForTrigger = (
  catalog: Catalog,
  trigger: TriggerDescriptor
): IntegrationDescriptor | undefined =>
  catalog.definitions.find((definition): definition is IntegrationDescriptor =>
    definition.kind === "integration" &&
    definition.definition.id === trigger.integration.id &&
    definition.definition.version === trigger.integration.version)

export const actionArgumentNames = (action: ActionDescriptor): ReadonlyArray<string> => {
  const schema = action.argumentsSchema.schema
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return []
  const properties = (schema as { readonly properties?: unknown }).properties
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return []
  return Object.keys(properties)
}

export const triggerIsGithubIssue = (catalog: Catalog, form: RoutineEditorForm): boolean => {
  const trigger = form.triggerKey === "" ? undefined : triggerForKey(catalog, form.triggerKey)
  return trigger?.definition.id === "github:issue-opened"
}

export const routineIdProblem = (form: RoutineEditorForm): string | undefined =>
  form.routineId.trim().length === 0 ? "Enter a routine id." : undefined

export const formFromTemplate = (template: RoutineDescriptor): RoutineEditorForm => {
  const extracted = extractProcessForm(template.process)
  return {
    ...blankEditorForm(),
    templateKey: definitionKeyOf(template.definition),
    triggerKey: extracted.triggerKey,
    integrationId: extracted.integrationId,
    useDecision: extracted.useDecision,
    categories: extracted.categories
  }
}

export const formFromRoutine = (record: RoutineRecord): RoutineEditorForm => {
  const extracted = extractProcessForm(record.configuration.process)
  const stored = readRecord(record.configuration.configuration)
  const integration = record.configuration.integrations[0]
  const storedIntegration = integration === undefined ? undefined : readRecord(integration.configuration)
  return {
    ...blankEditorForm(),
    routineId: record.routineId,
    templateKey: record.configuration.template === undefined
      ? blankTemplateKey
      : definitionKeyOf(record.configuration.template),
    triggerKey: extracted.triggerKey,
    integrationId: integration?.id ?? extracted.integrationId,
    owner: readText(storedIntegration?.["owner"]) ?? "",
    repo: readText(storedIntegration?.["repo"]) ?? "",
    useDecision: extracted.useDecision,
    categories: extracted.categories.map((category) => ({
      ...category,
      label: readLabels(stored)[category.name] ?? category.label
    })),
    notifyOnMatch: readNotifications(stored).onMatch,
    notifyOnNoMatch: readNotifications(stored).onNoMatch
  }
}

export const headForRoutine = (record: RoutineRecord): RoutineHead => record.head

export const routineWriteFromForm = (form: RoutineEditorForm, catalog: Catalog): RoutineWriteResult => {
  const problems: Array<string> = []
  const trigger = form.triggerKey === "" ? undefined : triggerForKey(catalog, form.triggerKey)
  if (trigger === undefined) problems.push("Choose exactly one trigger from the catalog.")
  const integration = trigger === undefined ? undefined : integrationForTrigger(catalog, trigger)
  if (trigger !== undefined && integration === undefined) {
    problems.push(`The selected trigger "${form.triggerKey}" has no registered integration.`)
  }
  const githubTrigger = trigger?.definition.id === "github:issue-opened"
  const githubIntegration = integration?.definition.id === "github:integration"
  const names = form.useDecision ? form.categories.map((category) => category.name.trim()) : []
  if (githubTrigger && !form.useDecision) {
    problems.push("The GitHub issue trigger needs a Jev decision step with at least one category.")
  }
  if (form.useDecision && names.length === 0) problems.push("Add at least one category for the Jev decision step.")
  const seen = new Set<string>()
  for (const [position, name] of names.entries()) {
    if (name.length === 0) problems.push(`Category ${position + 1} needs a name.`)
    else if (seen.has(name)) problems.push(`Duplicate category "${name}".`)
    else seen.add(name)
  }
  const instanceId = form.integrationId.trim()
  if (instanceId.length === 0) problems.push("Enter an integration instance id.")
  if (githubIntegration && (form.owner.trim().length === 0 || form.repo.trim().length === 0)) {
    problems.push("Enter the repository owner and name.")
  }
  if (form.unmatchedBehavior !== leaveUnchangedBehavior) problems.push("Unmatched input must leave the input unchanged.")
  const groups = form.useDecision
    ? form.categories
    : form.categories.filter((entry) => entry.name.trim() === triggeredOutcomeId)
  for (const category of groups) {
    const display = category.name.trim() === "" ? "Unnamed category" : `Category "${category.name.trim()}"`
    if (form.useDecision && category.label.trim().length === 0) problems.push(`${display} needs a label.`)
    if (githubTrigger && category.steps.length === 0) {
      problems.push(`${display} needs at least one action.`)
    }
    for (const [stepIndex, step] of category.steps.entries()) {
      if (step.actionKey === "" || (trigger !== undefined && actionForKey(catalog, step.actionKey) === undefined)) {
        problems.push(`${display} action ${stepIndex + 1} needs a registered action.`)
      }
    }
  }
  if (trigger === undefined || integration === undefined || instanceId.length === 0) {
    return { write: undefined, problems }
  }
  const outcomes = form.useDecision && names.length > 0 ? names : [triggeredOutcomeId]
  const actions: { [outcome: string]: RoutineWrite["process"]["actions"][string] } = {}
  for (const outcome of outcomes) {
    const category = form.categories.find((entry) => entry.name.trim() === outcome)
    const steps = category === undefined ? [] : category.steps
    actions[outcome] = steps.map((step, index) =>
      buildActionStep(catalog, step, category, outcome, index, githubTrigger, instanceId, integration.definition))
  }
  const labels: { [category: string]: string } = {}
  const descriptions: { [category: string]: string } = {}
  for (const category of form.categories) {
    const name = category.name.trim()
    if (name.length === 0) continue
    labels[name] = category.label.trim()
    descriptions[name] = category.label.trim()
  }
  const notifications = { onMatch: form.notifyOnMatch, onNoMatch: form.notifyOnNoMatch }
  const configuration = githubTrigger
    ? { categories: names, labels, notifications }
    : form.useDecision
      ? { categories: names, descriptions, notifications }
      : {}
  const template = form.templateKey === blankTemplateKey ? undefined : templateForKey(catalog, form.templateKey)
  const write: RoutineWrite = {
    ...(template === undefined ? {} : { template: template.definition }),
    configuration,
    integrations: [{
      schemaVersion: 1,
      kind: "integration-configuration",
      id: instanceId,
      definition: integration.definition,
      configuration: githubIntegration ? { owner: form.owner.trim(), repo: form.repo.trim() } : {},
      credentials: githubIntegration
        ? {
            token: {
              schemaVersion: 1 as const,
              kind: "credential-reference" as const,
              credentialId: "github-token"
            }
          }
        : {}
    }],
    process: {
      schemaVersion: 1,
      kind: "process",
      trigger: {
        definition: trigger.definition,
        integration: { id: instanceId, definition: integration.definition },
        configuration: {}
      },
      ...(form.useDecision && names.length > 0
        ? { decision: { kind: "jev", provider: "opencode-zen", model: "jev", version: "1.13", outcomes: names } }
        : {}),
      actions
    }
  }
  return { write, problems }
}

export const previewDecision = (outcomeId: string | undefined, reason: string): JevDecisionResult =>
  outcomeId === undefined
    ? { schemaVersion: 1, kind: "abstained", reason: reason.trim().length === 0 ? "No candidate matched the input" : reason.trim() }
    : { schemaVersion: 1, kind: "selected", outcomeId, data: {} }

export const definitionKeyOf = (reference: { readonly id: string; readonly version: number }): string =>
  `${reference.id}@${reference.version}`

interface ExtractedProcessForm {
  readonly triggerKey: string
  readonly integrationId: string
  readonly useDecision: boolean
  readonly categories: ReadonlyArray<EditorCategoryInput>
}

const extractProcessForm = (process: unknown): ExtractedProcessForm => {
  const record = readRecord(process)
  const trigger = record?.["trigger"] === undefined ? undefined : readRecord(record?.["trigger"])
  const triggerDefinition = readDefinitionReference(trigger?.["definition"])
  const triggerIntegration = readRecord(trigger?.["integration"])
  const decision = record?.["decision"] === undefined ? undefined : readRecord(record?.["decision"])
  const outcomes = readLocalIds(decision?.["outcomes"])
  const actions = record?.["actions"] === undefined ? undefined : readRecord(record?.["actions"])
  const categories: Array<EditorCategoryInput> = []
  if (outcomes === undefined) {
    const extracted = actions === undefined ? emptyExtractedSteps : extractSteps(actions[triggeredOutcomeId])
    if (extracted.steps.length > 0) categories.push({ name: triggeredOutcomeId, label: "", steps: extracted.steps })
    return {
      triggerKey: triggerDefinition === undefined ? "" : definitionKeyOf(triggerDefinition),
      integrationId: readText(triggerIntegration?.["id"]) ?? "github",
      useDecision: false,
      categories
    }
  }
  for (const outcome of outcomes) {
    const extracted = actions === undefined ? emptyExtractedSteps : extractSteps(actions[outcome])
    categories.push({ name: outcome, label: extracted.label ?? outcome, steps: extracted.steps })
  }
  return {
    triggerKey: triggerDefinition === undefined ? "" : definitionKeyOf(triggerDefinition),
    integrationId: readText(triggerIntegration?.["id"]) ?? "github",
    useDecision: true,
    categories
  }
}

interface ExtractedSteps {
  readonly steps: ReadonlyArray<EditorStepInput>
  readonly label: string | undefined
}

const emptyExtractedSteps: ExtractedSteps = { steps: [], label: undefined }

const extractSteps = (value: unknown): ExtractedSteps => {
  if (!Array.isArray(value)) return emptyExtractedSteps
  const steps: Array<EditorStepInput> = []
  let label: string | undefined = undefined
  for (const entry of value) {
    const record = readRecord(entry)
    const action = readDefinitionReference(record?.["action"])
    if (action === undefined) continue
    const bindings = record?.["bindings"] === undefined ? undefined : readRecord(record?.["bindings"])
    if (label === undefined && bindings !== undefined) label = readLiteralString(bindings["label"])
    const values: { [argument: string]: string } = {}
    if (bindings !== undefined) {
      for (const [argument, binding] of Object.entries(bindings)) {
        if (argument === "label" || argument === "issueNumber") continue
        const literal = readLiteralString(binding)
        if (literal !== undefined) values[argument] = literal
      }
    }
    steps.push({ actionKey: definitionKeyOf(action), values })
  }
  return { steps, label }
}

const buildActionStep = (
  catalog: Catalog,
  step: EditorStepInput,
  category: EditorCategoryInput | undefined,
  outcome: string,
  index: number,
  githubTrigger: boolean,
  integrationId: string,
  integrationDefinition: { readonly id: string; readonly version: number }
): RoutineWrite["process"]["actions"][string][number] => {
  const action = step.actionKey === "" ? undefined : actionForKey(catalog, step.actionKey)
  const fallback = { id: "github:label-issue" as const, version: 1 as const }
  const reference = action === undefined ? fallback : action.definition
  const names = action === undefined ? ["issueNumber", "label"] : actionArgumentNames(action)
  const bindings: { [argument: string]: { readonly kind: "literal"; readonly value: string } | { readonly kind: "field"; readonly source: "trigger"; readonly path: ReadonlyArray<string> } } = {}
  for (const argument of names) {
    if (argument === "issueNumber" && githubTrigger) {
      bindings[argument] = { kind: "field", source: "trigger", path: ["issueNumber"] }
    } else if (argument === "label" && reference.id === "github:label-issue") {
      const categoryLabel = category?.label.trim()
      bindings[argument] = {
        kind: "literal",
        value: categoryLabel !== undefined && categoryLabel !== "" ? categoryLabel : (step.values[argument] ?? "")
      }
    } else {
      bindings[argument] = { kind: "literal", value: step.values[argument] ?? "" }
    }
  }
  return {
    id: stepIdFor(reference.id, category?.name.trim() || outcome, index),
    action: { id: reference.id, version: reference.version },
    integration: { id: integrationId, definition: integrationDefinition },
    bindings
  }
}

const stepIdFor = (actionId: string, outcome: string, index: number): string => {
  const slug = (value: string): string => {
    const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    return cleaned.length === 0 ? "step" : cleaned
  }
  const short = actionId.includes(":") ? actionId.slice(actionId.lastIndexOf(":") + 1) : actionId
  const base = `${slug(short)}-${slug(outcome)}`
  return index === 0 ? base : `${base}-${index + 1}`
}

const readRecord = (value: unknown): { readonly [key: string]: unknown } | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as { readonly [key: string]: unknown }
}

const readText = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

const readLocalIds = (value: unknown): ReadonlyArray<string> | undefined => {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const ids: Array<string> = []
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) return undefined
    ids.push(entry)
  }
  return ids
}

const readDefinitionReference = (value: unknown): { readonly id: string; readonly version: number } | undefined => {
  const record = readRecord(value)
  const id = record?.["id"]
  const version = record?.["version"]
  if (typeof id !== "string" || id.length === 0) return undefined
  if (typeof version !== "number" || !Number.isInteger(version) || version <= 0) return undefined
  return { id, version }
}

const readLiteralString = (binding: unknown): string | undefined => {
  const record = readRecord(binding)
  if (record?.["kind"] !== "literal") return undefined
  const value = record?.["value"]
  return typeof value === "string" ? value : undefined
}

const readLabels = (configuration: { readonly [key: string]: unknown } | undefined): { readonly [key: string]: string } => {
  const labels = configuration?.["labels"]
  const record = readRecord(labels)
  if (record === undefined) return {}
  const result: { [key: string]: string } = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") result[key] = value
  }
  return result
}

const readNotifications = (configuration: { readonly [key: string]: unknown } | undefined): { readonly onMatch: boolean; readonly onNoMatch: boolean } => {
  const record = readRecord(configuration?.["notifications"])
  const onMatch = record?.["onMatch"]
  const onNoMatch = record?.["onNoMatch"]
  return {
    onMatch: onMatch === undefined ? true : onMatch === true,
    onNoMatch: onNoMatch === undefined ? true : onNoMatch === true
  }
}
