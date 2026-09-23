import { Window } from "happy-dom"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { RootLayout } from "@expand/desktop/renderer/app/shell/root-layout"

const route = vi.hoisted(() => ({
  pathname: "/p/alpha",
  navigate: vi.fn()
}))

vi.mock("@tanstack/react-router", () => import("react").then((React) => ({
    Outlet: () => React.createElement("div", { "data-testid": "route-content" }, "Current route"),
    useNavigate: () => route.navigate,
    useRouterState: ({ select }: { readonly select: (state: { location: { pathname: string } }) => unknown }) =>
      select({ location: { pathname: route.pathname } })
  })))

vi.mock("@expand/desktop/renderer/features/sidebar/components/AppSidebar", () => import("react").then((React) => ({
    AppSidebar: ({
      activeConversationId,
      onSelectConversation,
      onSelectDevice,
      onSelectProject
    }: {
      readonly activeConversationId: string | null
      readonly onSelectConversation: (conversationId: string) => void
      readonly onSelectDevice: (deviceId: string) => void
      readonly onSelectProject: (projectId: string) => void
    }) => React.createElement("nav", null,
      React.createElement("button", {
        type: "button",
        "aria-current": activeConversationId === "conv-sidebar-shape" ? "true" : undefined,
        onClick: () => onSelectConversation("conv-sidebar-shape")
      }, "Select sample"),
      React.createElement("button", {
        type: "button",
        onClick: () => onSelectDevice("device-field")
      }, "Select device"),
      React.createElement("button", {
        type: "button",
        onClick: () => onSelectProject("beta")
      }, "Select project")
    )
  })))

vi.mock("@expand/desktop/renderer/features/command/components/CommandPalette", () => import("react").then((React) => ({
  CommandPalette: ({ onProjectOpened }: { readonly onProjectOpened?: () => void }) =>
    React.createElement("button", {
      type: "button",
      onClick: onProjectOpened
    }, "Open current project from palette")
})))

const browser = new Window({ url: "http://localhost/" })
let dom: typeof import("@testing-library/react")

beforeAll(() => {
  vi.stubGlobal("window", browser)
  vi.stubGlobal("document", browser.document)
  vi.stubGlobal("navigator", browser.navigator)
  vi.stubGlobal("HTMLElement", browser.HTMLElement)
  vi.stubGlobal("Element", browser.Element)
  vi.stubGlobal("Node", browser.Node)
  return import("@testing-library/react").then((testing) => {
    dom = testing
  })
})

afterEach(() => {
  dom.cleanup()
  route.pathname = "/p/alpha"
  route.navigate.mockReset()
})

afterAll(() => {
  vi.unstubAllGlobals()
  return browser.happyDOM.abort()
})

describe("RootLayout conversation preview", () => {
  it("shows the selected sample in the workspace and returns to the route", () => {
    dom.render(<RootLayout />)
    dom.fireEvent.click(dom.screen.getByRole("button", { name: "Open sidebar" }))
    expect(dom.screen.getByRole("button", { name: "Open sidebar" }).getAttribute("aria-expanded")).toBe("true")

    dom.fireEvent.click(dom.screen.getByRole("button", { name: "Select sample" }))
    expect(dom.screen.queryByTestId("route-content")).toBeNull()
    expect(dom.screen.getByText("Sample conversation preview")).toBeDefined()
    expect(dom.screen.getByRole("heading", { name: "Sidebar three-zone shape" })).toBeDefined()
    expect(dom.screen.getByText("Rail holds devices, the panel holds the project switcher and the worktree inbox.")).toBeDefined()
    expect(dom.screen.getByRole("button", { name: "Select sample" }).getAttribute("aria-current")).toBe("true")
    expect(dom.screen.getByRole("button", { name: "Open sidebar" }).getAttribute("aria-expanded")).toBe("false")

    dom.fireEvent.click(dom.screen.getByRole("button", { name: "Back to workspace" }))
    expect(dom.screen.getByTestId("route-content")).toBeDefined()
    expect(dom.screen.queryByText("Sample conversation preview")).toBeNull()
    expect(dom.screen.getByRole("button", { name: "Select sample" }).getAttribute("aria-current")).toBeNull()
  })

  it("clears the preview when the device, project, or route changes", () => {
    const rendered = dom.render(<RootLayout />)

    dom.fireEvent.click(dom.screen.getByRole("button", { name: "Select sample" }))
    dom.fireEvent.click(dom.screen.getByRole("button", { name: "Select device" }))
    expect(dom.screen.getByTestId("route-content")).toBeDefined()

    dom.fireEvent.click(dom.screen.getByRole("button", { name: "Select sample" }))
    dom.fireEvent.click(dom.screen.getByRole("button", { name: "Select project" }))
    expect(dom.screen.getByTestId("route-content")).toBeDefined()
    expect(route.navigate).toHaveBeenCalledWith({ to: "/p/$projectId", params: { projectId: "beta" } })

    dom.fireEvent.click(dom.screen.getByRole("button", { name: "Select sample" }))
    route.pathname = "/"
    rendered.rerender(<RootLayout />)
    expect(dom.screen.getByTestId("route-content")).toBeDefined()
    route.pathname = "/p/alpha"
    rendered.rerender(<RootLayout />)
    expect(dom.screen.queryByText("Sample conversation preview")).toBeNull()
  })

  it("clears the preview when the palette opens the current project without changing the route", () => {
    dom.render(<RootLayout />)

    dom.fireEvent.click(dom.screen.getByRole("button", { name: "Select sample" }))
    expect(dom.screen.getByText("Sample conversation preview")).toBeDefined()

    dom.fireEvent.click(dom.screen.getByRole("button", { name: "Open current project from palette" }))

    expect(route.pathname).toBe("/p/alpha")
    expect(dom.screen.getByTestId("route-content")).toBeDefined()
    expect(dom.screen.queryByText("Sample conversation preview")).toBeNull()
  })
})
