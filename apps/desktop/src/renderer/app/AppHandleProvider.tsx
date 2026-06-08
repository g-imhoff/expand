import { createContext, type ReactNode, useContext } from "react"
import type { AppHandle } from "@yodea/desktop/renderer/app/app-handle"

const AppHandleContext = createContext<AppHandle | null>(null)

export const AppHandleProvider = ({ value, children }: { value: AppHandle; children: ReactNode }) => (
  <AppHandleContext.Provider value={value}>{children}</AppHandleContext.Provider>
)

export const useAppHandle = (): AppHandle => {
  const handle = useContext(AppHandleContext)
  if (handle === null) throw new Error("useAppHandle must be used within <AppHandleProvider>")
  return handle
}
