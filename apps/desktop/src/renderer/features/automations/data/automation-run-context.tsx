import { createContext, type ReactNode, useContext } from "react"
import type { AutomationRpcApi } from "@expand/desktop/renderer/rpc/automation-rpc"

export interface AutomationRunContextValue {
  readonly rpc: AutomationRpcApi
}

export {
  AutomationRunContextProvider,
  useOptionalAutomationRpc
}

const AutomationRunContextProvider = ({
  value,
  children
}: {
  readonly value: AutomationRunContextValue
  readonly children: ReactNode
}) => <AutomationRunContext.Provider value={value}>{children}</AutomationRunContext.Provider>

const useOptionalAutomationRpc = (): AutomationRpcApi | undefined => {
  const value = useContext(AutomationRunContext)
  return value === null ? undefined : value.rpc
}

const AutomationRunContext = createContext<AutomationRunContextValue | null>(null)
