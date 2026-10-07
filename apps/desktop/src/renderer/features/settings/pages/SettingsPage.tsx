import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useProjects } from "@expand/desktop/renderer/features/projects/data/use-projects"
import { ConnectionSettingsPage } from "@expand/desktop/renderer/features/settings/components/ConnectionSettingsPage"
import { useConnectionSettings } from "@expand/desktop/renderer/features/settings/data/use-connection-settings"

export const SettingsPage = () => {
  const { data: projects } = useProjects()
  const visible = projects.filter((project) => !project.archived)
  const [projectId, setProjectId] = useState<string | undefined>(undefined)
  const selected = visible.find((project) => project.id === projectId) ?? visible[0] ?? null
  return (
    <section className="mx-auto w-full min-w-0 max-w-5xl px-6 py-8">
      <header>
        <Link to="/" className="text-sm text-muted-foreground underline">
          Projects
        </Link>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <label htmlFor="settings-project" className="text-sm text-muted-foreground">Project</label>
          <select
            id="settings-project"
            value={selected?.id ?? ""}
            onChange={(event) => setProjectId(event.target.value)}
            className="h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm"
          >
            {visible.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </div>
      </header>
      {selected === null ? (
        <div className="py-8">
          <h1 className="text-2xl font-semibold">Settings</h1>
          <p className="mt-3 text-sm text-muted-foreground">Create a project first. Connections are stored per project.</p>
        </div>
      ) : (
        <SettingsContent key={selected.id} projectId={selected.id} />
      )}
    </section>
  )
}

const SettingsContent = ({ projectId }: { readonly projectId: string }) => {
  const binding = useConnectionSettings(projectId)
  return (
    <ConnectionSettingsPage
      model={binding.model}
      oauthUnavailable
      onStartGithubOAuth={() => {}}
      onPushToGh={() => {}}
      onSaveZenKey={binding.saveZenKey}
      onTestConnection={binding.testConnection}
      onRetry={binding.retry}
    />
  )
}
