import { useRegisteredIntegrations } from "@expand/desktop/renderer/features/automations/data/use-integrations"
import { describeAutomationError } from "@expand/desktop/renderer/features/automations/model/integration-messages"

export const RegisteredIntegrations = () => {
  const { registrations, error, isLoading, unavailable, retry } = useRegisteredIntegrations()

  return (
    <section aria-labelledby="registered-integrations-heading">
      <h2 id="registered-integrations-heading" className="text-lg font-semibold">Registered integrations</h2>
      {unavailable ? (
        <p className="mt-2 text-sm text-muted-foreground">Automation services are unavailable in this session.</p>
      ) : isLoading ? (
        <p className="mt-2 text-sm text-muted-foreground">Loading registered integrations…</p>
      ) : error !== undefined ? (
        <>
          <p role="alert" className="mt-2 text-sm text-destructive">{describeAutomationError(error)}</p>
          <button type="button" onClick={retry} className="mt-2 text-sm underline">Retry</button>
        </>
      ) : registrations === undefined || registrations.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">No integrations are registered on the backend yet.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {registrations.map((registration) => (
            <li key={`${registration.id}@${registration.version}`} className="rounded-md border px-3 py-2">
              <p className="text-sm font-medium">{registration.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{registration.id} version {registration.version}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
