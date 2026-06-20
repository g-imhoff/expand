import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test"
import { resolve } from "node:path"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"

const repoRoot = resolve(__dirname, "../../..")

export interface LaunchedApp {
  readonly app: ElectronApplication
  readonly win: Page
}

export const launchApp = async (): Promise<LaunchedApp> => {
  // Isolate this run's data to a throwaway dir. The desktop main process resolves
  // its AppContext base from the `--data-dir` argv we pass here, and the node
  // adapter forwards that same dir to the spawned server via `--data-dir`, so both
  // sides rendezvous on the same endpoint file without any env override.
  const dataHome = mkdtempSync(resolve(tmpdir(), "yodea-e2e-home-"))
  const app = await electron.launch({
    args: ["--no-sandbox", resolve(__dirname, "../out/main/index.mjs"), "--data-dir", dataHome],
    env: {
      ...process.env,
      YODEA_BACKEND_CMD: JSON.stringify(["bun", resolve(repoRoot, "apps/server/main.ts")])
    }
  })
  const win = await app.firstWindow()
  await win.getByText("Projects (").waitFor()
  return { app, win }
}

// Creates a project via the inline form on the main view and waits for it to appear.
export const createProject = async (win: Page, name: string): Promise<void> => {
  await win.getByLabel("project name").fill(name)
  await win.getByRole("button", { name: "Create" }).click()
  await win.getByTestId("project-list").getByText(name, { exact: true }).waitFor()
}

// Opens the command palette with Ctrl/Cmd+Shift+P (works on both platforms).
export const openPalette = async (win: Page): Promise<void> => {
  const mod = process.platform === "darwin" ? "Meta" : "Control"
  await win.keyboard.press(`${mod}+Shift+P`)
  await win.getByPlaceholder("Type a project name or search…").waitFor()
}
