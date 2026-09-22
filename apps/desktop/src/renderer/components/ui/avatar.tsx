// Adapted from the vendored sidebar-09 block (shadcn new-york-v4) for the
// Expand desktop renderer. Avatar images are intentionally unsupported here:
// the specimen ships no external assets, so callers use AvatarFallback with
// initials.
import * as React from "react"
import { cn } from "./class-names"
import { Avatar as AvatarPrimitive } from "radix-ui"

export const Avatar = ({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root> & {
  size?: "default" | "sm" | "lg"
}) => (
  <AvatarPrimitive.Root
    data-slot="avatar"
    data-size={size}
    className={cn(
      "group/avatar relative flex size-8 shrink-0 overflow-hidden rounded-full select-none data-[size=lg]:size-10 data-[size=sm]:size-6",
      className
    )}
    {...props}
  />
)

export const AvatarFallback = ({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Fallback>) => (
  <AvatarPrimitive.Fallback
    data-slot="avatar-fallback"
    className={cn(
      "flex size-full items-center justify-center rounded-full bg-muted text-sm text-muted-foreground group-data-[size=sm]/avatar:text-xs",
      className
    )}
    {...props}
  />
)
