import { useParams } from "@tanstack/react-router"
import { GithubConnection } from "@expand/desktop/renderer/features/automations/components/GithubConnection"
import { RegisteredIntegrations } from "@expand/desktop/renderer/features/automations/components/RegisteredIntegrations"
import { ZenConnection } from "@expand/desktop/renderer/features/automations/components/ZenConnection"
import { automationScopeForProject } from "@expand/desktop/renderer/features/automations/model/integration-messages"

export const AutomationIntegrations = () => {
  const { projectId } = useParams({ from: "/p/$projectId/automations" })
  const scope = automationScopeForProject(projectId)
  return (
    <>
      <h1 className="text-2xl font-semibold">Integrations</h1>
      <p className="mt-3 text-sm text-muted-foreground">Connect the services your automations use.</p>
      <div className="mt-6 flex flex-col gap-8">
        <RegisteredIntegrations />
        <GithubConnection scope={scope} />
        <ZenConnection scope={scope} />
      </div>
    </>
  )
}
