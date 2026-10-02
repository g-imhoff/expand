import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"
import { cn } from "./class-names"

export const Popover = PopoverPrimitive.Root

export const PopoverTrigger = PopoverPrimitive.Trigger


export const PopoverContent = ({
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "bg-popover text-popover-foreground z-50 w-72 rounded-md border p-1 shadow-md outline-hidden",
        className
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
)
