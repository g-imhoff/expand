import * as React from "react"
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui"
import { CheckIcon } from "lucide-react"
import { cn } from "./class-names"

export const DropdownMenu = DropdownMenuPrimitive.Root

export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger

export const DropdownMenuGroup = DropdownMenuPrimitive.Group


export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup

export const DropdownMenuContent = ({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      sideOffset={sideOffset}
      className={cn(
        "bg-popover text-popover-foreground z-50 max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] min-w-52 overflow-x-hidden overflow-y-auto rounded-md border p-1 shadow-md",
        className
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
)

export const DropdownMenuItem = ({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item>) => (
  <DropdownMenuPrimitive.Item
    className={cn(
      "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className
    )}
    {...props}
  />
)

export const DropdownMenuLabel = ({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) => (
  <DropdownMenuPrimitive.Label
    className={cn("text-muted-foreground px-2 py-1.5 text-xs font-medium", className)}
    {...props}
  />
)

export const DropdownMenuSeparator = ({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) => (
  <DropdownMenuPrimitive.Separator className={cn("bg-border -mx-1 my-1 h-px", className)} {...props} />
)

export const DropdownMenuRadioItem = ({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) => (
  <DropdownMenuPrimitive.RadioItem
    className={cn(
      "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className
    )}
    {...props}
  >
    <span className="absolute left-2 flex size-3.5 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>
        <CheckIcon className="size-4" aria-hidden="true" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.RadioItem>
)
