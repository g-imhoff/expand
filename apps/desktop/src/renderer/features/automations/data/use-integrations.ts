import { useCallback, useEffect, useRef, useState } from "react"
import { Cause, Data, Effect, Exit, Option } from "effect"
import type { Catalog, CredentialStatus, PersonalScope } from "@expand/contracts/automation"
import type { GithubStatus } from "@expand/contracts/rpc/automation-schemas"
import { useRendererRunner } from "@expand/desktop/renderer/app/runner-context"
import { useAutomationRpc } from "@expand/desktop/renderer/features/projects/data/project-context"
import { useRunMutation } from "@expand/desktop/renderer/features/projects/data/use-projects"
import type { AutomationRpcError } from "@expand/client-ts/automation"
import type { AutomationRpcApi } from "@expand/desktop/renderer/rpc/automation-rpc"
import {
  githubCredentialId,
  githubIntegrationId,
  zenCredentialId
} from "@expand/desktop/renderer/features/automations/model/integration-messages"

export interface RegisteredIntegration {
  readonly id: string
  readonly version: number
  readonly title: string
}

export interface RegisteredIntegrationsState {
  readonly registrations: ReadonlyArray<RegisteredIntegration> | undefined
  readonly error: unknown
  readonly isLoading: boolean
  readonly unavailable: boolean
  readonly retry: () => void
}

export interface CredentialStatusesState {
  readonly credentials: ReadonlyArray<CredentialStatus> | undefined
  readonly error: unknown
  readonly isLoading: boolean
  readonly unavailable: boolean
  readonly retry: () => void
}

export interface GithubConnectInput {
  readonly owner: string
  readonly repo: string
  readonly token: string
}

export interface ConnectOptions {
  readonly onSuccess?: () => void
}

export interface GithubConnectState {
  readonly connect: (input: GithubConnectInput, options?: ConnectOptions) => void
  readonly connectError: unknown
  readonly isConnectPending: boolean
  readonly resetConnect: () => void
  readonly unavailable: boolean
}

export interface GithubStatusCheck {
  readonly status: GithubStatus | undefined
  readonly statusError: unknown
  readonly isStatusPending: boolean
  readonly check: () => void
  readonly resetStatus: () => void
  readonly unavailable: boolean
}

export interface ZenConnectState {
  readonly connect: (apiKey: string, options?: ConnectOptions) => void
  readonly connectError: unknown
  readonly isConnectPending: boolean
  readonly resetConnect: () => void
  readonly unavailable: boolean
}

export const useRegisteredIntegrations = (): RegisteredIntegrationsState => {
  const query = useAutomationQuery((api) => api.catalog(), "catalog")
  const catalog = query.data
  return {
    registrations: catalog === undefined ? undefined : collectRegistrations(catalog),
    error: query.error,
    isLoading: query.isLoading,
    unavailable: query.unavailable,
    retry: query.retry
  }
}

export const useCredentialStatuses = (scope: PersonalScope): CredentialStatusesState => {
  const query = useAutomationQuery(
    (api) => api.credentialList({ scope }),
    `${scope.ownerId}/${scope.projectId}`
  )
  const listed = query.data
  return {
    credentials: listed === undefined ? undefined : [...listed.credentials],
    error: query.error,
    isLoading: query.isLoading,
    unavailable: query.unavailable,
    retry: query.retry
  }
}

export const useGithubConnect = (scope: PersonalScope): GithubConnectState => {
  const rpc = useAutomationRpc()
  const mutation = useRunMutation((
    input: GithubConnectInput
  ): Effect.Effect<{ readonly version: number }, AutomationRpcError | AutomationUnavailable> =>
    rpc === undefined
      ? Effect.fail(new AutomationUnavailable({ message: "Automation services are unavailable in this session." }))
      : Effect.flatMap(
        rpc.credentialPut({ scope, credentialId: githubCredentialId, secret: input.token }),
        () =>
          rpc.integrationPut({
            scope,
            integration: {
              schemaVersion: 1 as const,
              kind: "integration-configuration" as const,
              id: githubIntegrationId,
              definition: { id: "github:integration" as const, version: 1 as const },
              configuration: { owner: input.owner, repo: input.repo },
              credentials: {
                token: {
                  schemaVersion: 1 as const,
                  kind: "credential-reference" as const,
                  credentialId: githubCredentialId
                }
              }
            }
          })
      ))
  return {
    connect: (input, options) => {
      if (options?.onSuccess === undefined) {
        mutation.mutate(input)
        return
      }
      const { onSuccess } = options
      mutation.mutate(input, { onSuccess })
    },
    connectError: mutation.error,
    isConnectPending: mutation.isPending,
    resetConnect: mutation.reset,
    unavailable: rpc === undefined
  }
}

export const useGithubStatusCheck = (scope: PersonalScope): GithubStatusCheck => {
  const rpc = useAutomationRpc()
  const [status, setStatus] = useState<GithubStatus | undefined>(undefined)
  const mutation = useRunMutation((
    current: PersonalScope
  ): Effect.Effect<GithubStatus, AutomationRpcError | AutomationUnavailable> =>
    rpc === undefined
      ? Effect.fail(new AutomationUnavailable({ message: "Automation services are unavailable in this session." }))
      : rpc.integrationStatus({ scope: current, integrationId: githubIntegrationId }))
  return {
    status,
    statusError: mutation.error,
    isStatusPending: mutation.isPending,
    check: () => mutation.mutate(scope, { onSuccess: setStatus }),
    resetStatus: () => {
      setStatus(undefined)
      mutation.reset()
    },
    unavailable: rpc === undefined
  }
}

export const useZenConnect = (scope: PersonalScope): ZenConnectState => {
  const rpc = useAutomationRpc()
  const mutation = useRunMutation((
    apiKey: string
  ): Effect.Effect<CredentialStatus, AutomationRpcError | AutomationUnavailable> =>
    rpc === undefined
      ? Effect.fail(new AutomationUnavailable({ message: "Automation services are unavailable in this session." }))
      : rpc.credentialPut({ scope, credentialId: zenCredentialId, secret: apiKey }))
  return {
    connect: (apiKey, options) => {
      if (options?.onSuccess === undefined) {
        mutation.mutate(apiKey)
        return
      }
      const { onSuccess } = options
      mutation.mutate(apiKey, { onSuccess })
    },
    connectError: mutation.error,
    isConnectPending: mutation.isPending,
    resetConnect: mutation.reset,
    unavailable: rpc === undefined
  }
}

class AutomationUnavailable extends Data.TaggedError("AutomationUnavailable")<{
  readonly message: string
}> {}

interface AutomationQuery<A> {
  readonly data: A | undefined
  readonly error: unknown
  readonly isLoading: boolean
  readonly retry: () => void
  readonly unavailable: boolean
}

const useAutomationQuery = <A,>(
  run: (api: AutomationRpcApi) => Effect.Effect<A, unknown>,
  reloadKey: string
): AutomationQuery<A> => {
  const runner = useRendererRunner()
  const rpc = useAutomationRpc()
  const [data, setData] = useState<A | undefined>(undefined)
  const [error, setError] = useState<unknown>(undefined)
  const [isLoading, setIsLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const runRef = useRef(run)

  useEffect(() => {
    runRef.current = run
  })

  useEffect(() => {
    if (rpc === undefined) {
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    setError(undefined)
    let cancelled = false
    const cancel = runner.start(runRef.current(rpc), (exit) => {
      if (cancelled) return
      if (Exit.isSuccess(exit)) {
        setData(exit.value)
        setError(undefined)
        setIsLoading(false)
        return
      }
      if (Cause.hasDies(exit.cause)) throw Cause.squash(exit.cause)
      const failure = Cause.findErrorOption(exit.cause)
      if (Option.isNone(failure)) return
      setError(failure.value)
      setIsLoading(false)
    })
    return () => {
      cancelled = true
      cancel()
    }
  }, [runner, rpc, attempt, reloadKey])

  const retry = useCallback(() => {
    setAttempt((count) => count + 1)
  }, [])

  return { data, error, isLoading, retry, unavailable: rpc === undefined }
}

const collectRegistrations = (catalog: Catalog): ReadonlyArray<RegisteredIntegration> => {
  const registrations: Array<RegisteredIntegration> = []
  for (const definition of catalog.definitions) {
    if (definition.kind !== "integration") continue
    registrations.push({
      id: definition.definition.id,
      version: definition.definition.version,
      title: definition.title
    })
  }
  return registrations
}
