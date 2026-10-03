import { useProjects } from "@expand/desktop/renderer/features/projects/data/use-projects"
import { SidebarView, type SidebarViewProps } from "@expand/desktop/renderer/features/sidebar/components/SidebarView"

export type AppSidebarProps = Omit<SidebarViewProps, "projects">

export const AppSidebar = (props: AppSidebarProps) => {
  const { data: projects } = useProjects()
  return <SidebarView projects={projects} {...props} />
}
