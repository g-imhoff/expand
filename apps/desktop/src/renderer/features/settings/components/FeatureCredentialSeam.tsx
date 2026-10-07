import type { ReactNode } from "react"
import type { FeatureCredentialSeamModel } from "@expand/desktop/renderer/features/settings/model/settings-contract"

export interface FeatureCredentialSeamProps {
  readonly seam: FeatureCredentialSeamModel
  readonly onOpenSettings: (returnTarget: string) => void
  readonly children: (disabled: boolean) => ReactNode
}

export const FeatureCredentialSeam = ({ seam, onOpenSettings, children }: FeatureCredentialSeamProps) => {
  if (seam.connected) return <>{children(false)}</>
  return (
    <div className="flex flex-col gap-2">
      <div
        aria-disabled="true"
        title={`Connect ${seam.featureName} in settings to enable this. Your draft is preserved.`}
        className="opacity-70"
      >
        {children(true)}
      </div>
      <p className="text-sm text-muted-foreground">
        Connect {seam.featureName} in settings to enable this. Your draft is preserved.{" "}
        <button
          type="button"
          onClick={() => onOpenSettings(seam.returnTarget)}
          className="underline hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Open settings
        </button>
      </p>
    </div>
  )
}
