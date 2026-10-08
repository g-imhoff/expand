import * as React from "react"
import { cn } from "./class-names"
import { Slot } from "radix-ui"
import { useIsMobile } from "./use-mobile"
import { Input } from "./input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from "./sheet"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "./tooltip"

export interface SidebarContextProps {
  readonly state: "expanded" | "collapsed"
  readonly open: boolean
  readonly setOpen: (open: boolean) => void
  readonly openMobile: boolean
  readonly setOpenMobile: (open: boolean) => void
  readonly mobileTriggerRef: React.RefObject<HTMLButtonElement | null>
  readonly isMobile: boolean
  readonly toggleSidebar: () => void
}

export type SidebarMenuButtonVariant = "default" | "outline"

export type SidebarMenuButtonSize = "default" | "sm" | "lg"

export const useSidebar = (): SidebarContextProps => {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.")
  }

  return context
}

export const SidebarProvider = ({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) => {
  const isMobile = useIsMobile()
  const [openMobile, setOpenMobile] = React.useState(false)
  const mobileTriggerRef = React.useRef<HTMLButtonElement>(null)

  const [_open, _setOpen] = React.useState(defaultOpen)
  const open = openProp ?? _open
  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === "function" ? value(open) : value
      if (setOpenProp) {
        setOpenProp(openState)
      } else {
        _setOpen(openState)
      }

      document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`
    },
    [setOpenProp, open]
  )

  const toggleSidebar = React.useCallback(() => {
    return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open)
  }, [isMobile, setOpen, setOpenMobile])

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === SIDEBAR_KEYBOARD_SHORTCUT &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault()
        toggleSidebar()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [toggleSidebar])

  const state = open ? "expanded" : "collapsed"

  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      setOpenMobile,
      mobileTriggerRef,
      toggleSidebar
    }),
    [state, open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar]
  )

  return (
    <SidebarContext.Provider value={contextValue}>
      <TooltipProvider delayDuration={0}>
        <div
          data-slot="sidebar-wrapper"
          style={
            {
              "--sidebar-width": SIDEBAR_WIDTH,
              "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
              ...style
            } as React.CSSProperties
          }
          className={cn(
            "group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-sidebar",
            className
          )}
          {...props}
        >
          {children}
        </div>
      </TooltipProvider>
    </SidebarContext.Provider>
  )
}

export const Sidebar = ({
  side = "left",
  variant = "sidebar",
  collapsible = "offcanvas",
  resizable = false,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  side?: "left" | "right"
  variant?: "sidebar" | "floating" | "inset"
  collapsible?: "offcanvas" | "icon" | "none"
  resizable?: boolean
}) => {
  const { isMobile, state, openMobile, setOpenMobile, mobileTriggerRef } = useSidebar()
  const [width, setWidth] = React.useState(SIDEBAR_RESIZE_DEFAULT_WIDTH)
  const [viewportWidth, setViewportWidth] = React.useState(() => window.innerWidth)
  const [resizing, setResizing] = React.useState(false)
  const dragRef = React.useRef<{ readonly x: number; readonly width: number } | null>(null)
  const maxWidth = Math.max(SIDEBAR_RESIZE_MIN_WIDTH, Math.min(SIDEBAR_RESIZE_MAX_WIDTH, viewportWidth - SIDEBAR_CONTENT_MIN_WIDTH))
  const currentWidth = Math.min(width, maxWidth)
  const resize = (next: number) => {
    const bounded = Math.max(SIDEBAR_RESIZE_MIN_WIDTH, Math.min(Math.round(next), maxWidth))
    if (bounded !== currentWidth) setWidth(bounded)
  }

  React.useEffect(() => {
    if (!resizable) return
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [resizable])

  if (collapsible === "none") {
    return (
      <div
        data-slot="sidebar"
        className={cn(
          "flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground",
          className
        )}
        {...props}
      >
        {children}
      </div>
    )
  }

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile} {...props}>
        <SheetContent
          onCloseAutoFocus={(event) => {
            const trigger = mobileTriggerRef.current
            if (trigger?.isConnected) {
              event.preventDefault()
              trigger.focus()
            }
          }}
          data-sidebar="sidebar"
          data-slot="sidebar"
          data-mobile="true"
          showCloseButton={false}
          className={cn("w-[min(var(--sidebar-width),calc(100vw-1rem))] max-w-none bg-sidebar p-0 text-sidebar-foreground data-[state=open]:animate-[sidebar-slide-in_200ms_linear] data-[state=closed]:animate-[sidebar-slide-out_200ms_linear] motion-reduce:animate-none!", className)}
          style={
            {
              "--sidebar-width": SIDEBAR_WIDTH_MOBILE,
              "--sidebar-slide-offset": side === "left" ? "-100%" : "100%"
            } as React.CSSProperties
          }
          side={side}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Sidebar</SheetTitle>
            <SheetDescription>Displays the mobile sidebar.</SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 w-full flex-1 flex-row">{children}</div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <div
      className="group peer hidden text-sidebar-foreground md:block"
      data-state={state}
      data-collapsible={state === "collapsed" ? collapsible : ""}
      data-variant={variant}
      data-side={side}
      data-slot="sidebar"
      data-resizing={resizing || undefined}
      style={resizable ? { "--sidebar-width": `${currentWidth}px` } as React.CSSProperties : undefined}
    >
      <div
        data-slot="sidebar-gap"
        className={cn(
          "relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear motion-reduce:transition-none group-data-[resizing=true]:duration-0",
          "group-data-[collapsible=offcanvas]:w-0",
          "group-data-[side=right]:rotate-180",
          variant === "floating" || variant === "inset"
            ? "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]"
            : "group-data-[collapsible=icon]:w-(--sidebar-width-icon)"
        )}
      />
      <div
        data-slot="sidebar-container"
        className={cn(
          "fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[left,right,width] duration-200 ease-linear motion-reduce:transition-none group-data-[resizing=true]:duration-0 md:flex",
          side === "left"
            ? "left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]"
            : "right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]",
          variant === "floating" || variant === "inset"
            ? "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]"
            : "group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l",
          className
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
          className="flex h-full w-full flex-col overflow-hidden bg-sidebar group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:shadow-sm"
        >
          {children}
        </div>
        {resizable && state === "expanded" && (
          <div
            role="separator"
            tabIndex={0}
            aria-label="Resize sidebar"
            aria-orientation="vertical"
            aria-valuemin={SIDEBAR_RESIZE_MIN_WIDTH}
            aria-valuemax={maxWidth}
            aria-valuenow={currentWidth}
            data-slot="sidebar-resize-handle"
            className={cn(
              "absolute inset-y-0 z-20 w-2 cursor-col-resize touch-none select-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 hover:after:bg-sidebar-ring focus-visible:after:bg-sidebar-ring",
              side === "left" ? "-right-1" : "-left-1",
              resizing && "after:bg-sidebar-ring"
            )}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              event.preventDefault()
              event.currentTarget.focus()
              event.currentTarget.setPointerCapture(event.pointerId)
              dragRef.current = { x: event.clientX, width: currentWidth }
              setResizing(true)
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current
              if (drag) resize(drag.width + (event.clientX - drag.x) * (side === "left" ? 1 : -1))
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
              dragRef.current = null
              setResizing(false)
            }}
            onPointerCancel={() => {
              dragRef.current = null
              setResizing(false)
            }}
            onLostPointerCapture={() => {
              dragRef.current = null
              setResizing(false)
            }}
            onKeyDown={(event) => {
              const direction = side === "left" ? 1 : -1
              const step = event.shiftKey ? 64 : 16
              if (event.key === "ArrowLeft") resize(currentWidth - step * direction)
              else if (event.key === "ArrowRight") resize(currentWidth + step * direction)
              else if (event.key === "Home") resize(SIDEBAR_RESIZE_MIN_WIDTH)
              else if (event.key === "End") resize(maxWidth)
              else return
              event.preventDefault()
            }}
            onDoubleClick={() => resize(SIDEBAR_RESIZE_DEFAULT_WIDTH)}
          />
        )}
      </div>
    </div>
  )
}

export const SidebarInset = ({ className, ...props }: React.ComponentProps<"main">) => (
  <main
    data-slot="sidebar-inset"
    className={cn(
      "relative flex min-w-0 flex-1 flex-col bg-background",
      "md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2",
      className
    )}
    {...props}
  />
)

export const SidebarInput = ({ className, ...props }: React.ComponentProps<typeof Input>) => (
  <Input
    data-slot="sidebar-input"
    data-sidebar="input"
    className={cn("h-8 w-full bg-background shadow-none", className)}
    {...props}
  />
)

export const SidebarHeader = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div
    data-slot="sidebar-header"
    data-sidebar="header"
    className={cn("flex flex-col gap-2 p-2", className)}
    {...props}
  />
)

export const SidebarFooter = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div
    data-slot="sidebar-footer"
    data-sidebar="footer"
    className={cn("flex flex-col gap-2 p-2", className)}
    {...props}
  />
)

export const SidebarContent = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div
    data-slot="sidebar-content"
    data-sidebar="content"
    className={cn(
      "flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]:overflow-hidden",
      className
    )}
    {...props}
  />
)

export const SidebarGroup = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div
    data-slot="sidebar-group"
    data-sidebar="group"
    className={cn("relative flex w-full min-w-0 flex-col p-2", className)}
    {...props}
  />
)

export const SidebarGroupLabel = ({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> & { asChild?: boolean }) => {
  const Comp = asChild ? Slot.Root : "div"

  return (
    <Comp
      data-slot="sidebar-group-label"
      data-sidebar="group-label"
      className={cn(
        "flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 ring-sidebar-ring outline-hidden transition-[margin,opacity] duration-200 ease-linear motion-reduce:transition-none focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0",
        "group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0",
        className
      )}
      {...props}
    />
  )
}

export const SidebarGroupContent = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div
    data-slot="sidebar-group-content"
    data-sidebar="group-content"
    className={cn("w-full text-sm", className)}
    {...props}
  />
)

export const SidebarMenu = ({ className, ...props }: React.ComponentProps<"ul">) => (
  <ul
    data-slot="sidebar-menu"
    data-sidebar="menu"
    className={cn("flex w-full min-w-0 flex-col gap-1", className)}
    {...props}
  />
)

export const SidebarMenuItem = ({ className, ...props }: React.ComponentProps<"li">) => (
  <li
    data-slot="sidebar-menu-item"
    data-sidebar="menu-item"
    className={cn("group/menu-item relative", className)}
    {...props}
  />
)

export const SidebarMenuButton = ({
  asChild = false,
  isActive = false,
  variant = "default",
  size = "default",
  tooltip,
  className,
  ...props
}: React.ComponentProps<"button"> & {
  asChild?: boolean
  isActive?: boolean
  tooltip?: string | React.ComponentProps<typeof TooltipContent>
  variant?: SidebarMenuButtonVariant
  size?: SidebarMenuButtonSize
}) => {
  const Comp = asChild ? Slot.Root : "button"
  const { isMobile, state } = useSidebar()

  const button = (
    <Comp
      data-slot="sidebar-menu-button"
      data-sidebar="menu-button"
      data-size={size}
      data-active={isActive}
      className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
      {...props}
    />
  )

  if (!tooltip) {
    return button
  }

  if (typeof tooltip === "string") {
    tooltip = {
      children: tooltip
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent
        side="right"
        align="center"
        hidden={state !== "collapsed" || isMobile}
        {...tooltip}
      />
    </Tooltip>
  )
}

const sidebarMenuButtonVariantClass: Record<SidebarMenuButtonVariant, string> = {
  default: "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
  outline:
    "bg-background shadow-[0_0_0_1px_var(--sidebar-border)] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_var(--sidebar-accent)]"
}

const sidebarMenuButtonSizeClass: Record<SidebarMenuButtonSize, string> = {
  default: "h-8 text-sm",
  sm: "h-7 text-xs",
  lg: "h-12 text-sm group-data-[collapsible=icon]:p-0!"
}

const sidebarMenuButtonVariants = ({
  variant = "default",
  size = "default",
  className
}: {
  variant?: SidebarMenuButtonVariant | undefined
  size?: SidebarMenuButtonSize | undefined
  className?: string | undefined
} = {}): string =>
  cn(
    "peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm ring-sidebar-ring outline-hidden transition-[width,height,padding] group-has-data-[sidebar=menu-action]/menu-item:pr-8 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground data-[state=open]:hover:bg-sidebar-accent data-[state=open]:hover:text-sidebar-accent-foreground [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0",
    sidebarMenuButtonVariantClass[variant],
    sidebarMenuButtonSizeClass[size],
    className
  )

const SIDEBAR_COOKIE_NAME = "sidebar_state"

const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7

const SIDEBAR_WIDTH = "16rem"

const SIDEBAR_WIDTH_MOBILE = "20rem"

const SIDEBAR_WIDTH_ICON = "3rem"

const SIDEBAR_KEYBOARD_SHORTCUT = "b"

const SIDEBAR_RESIZE_DEFAULT_WIDTH = 320

const SIDEBAR_RESIZE_MIN_WIDTH = 288

const SIDEBAR_RESIZE_MAX_WIDTH = 480

const SIDEBAR_CONTENT_MIN_WIDTH = 320

const SidebarContext = React.createContext<SidebarContextProps | null>(null)
