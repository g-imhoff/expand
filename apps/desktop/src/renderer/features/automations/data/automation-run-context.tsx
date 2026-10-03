import { createContext, type ReactNode, useContext } from "react"
import type { AutomationRpcApi } from "@expand/desktop/renderer/rpc/automation-rpc"

export interface AutomationRunContextValue {
  readonly rpc: AutomationRpcApi
}

export const AutomationRunContextProvider = ({
  value,
  children
}: {
  readonly value: AutomationRunContextValue
  readonly children: ReactNode
}) => <AutomationRunContext.Provider value={value}>{children}</AutomationRunContext.Provider>

export const useAutomationRpc = (): AutomationRpcApi => {
  const value = useOptionalAutomationRpc()
  if (value === undefined) {
    throw new Error("automation rpc must be used within <AutomationRunContextProvider>")
  }
  return value
}

export const useOptionalAutomationRpc = (): AutomationRpcApi | undefined => {
  const value = useContext(AutomationRunContext)
  return value === null ? undefined : value.rpc
}

const AutomationRunContext = createContext<AutomationRunContextValue | null>(null)
