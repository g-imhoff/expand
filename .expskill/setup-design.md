---
schema_version: expskill.setup-design.v1
status: ready
---

# Setup Design

## Status

The method is a separate Vite browser preview that imports real production React components. The canary rendered `AppSidebar` from baseline `17379ca2f3a2299f99fc5f27c99bb5197fd11a62`. Setup readiness means the preview method passed its rendering and runtime observation checks. It does not approve production UI.

On 2026-10-08, the delegated AI user explicitly approved the support files, matching Chromium installation, isolated worktree, commit, safe integration and delivery through existing draft PR #58. The stated reason was that the method exercises real production components, providers and current tokens without replacing the stack or adding npm dependencies. This was a delegated AI setup decision, not a new human product preference or approval of assistant/responsibilities UI.

Delivery uses `feat/automation-workspace` against `develop` in `g-imhoff/expand`. The user's existing-draft-only instruction overrides the setup skill's separate non-draft PR delivery instruction. Do not mark PR #58 ready, merge it or push `develop`.

## Sketch location

Tracked support lives under `.expskill/design/`. The HTML entry is `.expskill/design/index.html`; the React entry is `.expskill/design/main.tsx`; the named fixture is `.expskill/design/scenarios/sidebar-two-worktrees-unread.tsx`. The Vite configuration is `.expskill/design/vite.config.ts`.

The setup candidate uses local branch `expskill/setup-design-acp` and isolated worktree `.worktrees/setup-design-acp`. Build output goes to `.tmp/design-preview/`. Browser proof output goes to `.tmp/setup-design-proof/`. Browser downloads go to `.cache/setup-design-browsers/`. These generated paths are ignored by Git.

## Seed and populate

Use an isolated clean checkout with the tracked setup support. Run these commands from that checkout's repository root:

```sh
npm ci --ignore-scripts --include=dev --include=optional
PLAYWRIGHT_BROWSERS_PATH=.cache/setup-design-browsers ./node_modules/.bin/playwright install chromium
```

No npm dependencies were added or upgraded. The existing lock fixes Vite at `7.3.6`, `@vitejs/plugin-react` at `5.2.0`, `@tailwindcss/vite` and Tailwind at `4.3.2`, and `@playwright/test` at `1.61.1`. Runtime components use existing React and React DOM `19.2.7`, Lucide `1.24.0`, Radix `1.6.2` and Zustand.

Populate the named scenario with schema-decoded synthetic projects and explicit production sidebar data types. Import production components and store factories. Do not copy a production component, use a replacement component or import the Vitest UI helper, which also imports Testing Library.

Skipping install scripts keeps preview installation from changing Git hooks or building native application dependencies. It also skips the Effect TypeScript patch, Electron download and SQLite build. This seed command proves only the browser preview prerequisites.

## Commands

Run every command from the repository root of the isolated checkout. Local prerequisites are Node `>=24.15`, npm `>=11`, installed locked development and optional dependencies, and Playwright's matching Chromium. Proof ran with Node `26.10.0`, npm `12.1.0` and Chromium `149.0.7827.55`, revision `1228`. npm differs from the declared `npm@11.12.1`; setup did not change that declaration or the installed toolchain.

Primary human command:

```sh
./node_modules/.bin/vite --config .expskill/design/vite.config.ts --host 127.0.0.1 --port 4173 --strictPort
```

Open `http://127.0.0.1:4173/`. At compact widths, `Control+b` opens the real mobile sidebar through the production provider shortcut. Stop the server before running the automated command, which starts its own server on the same port.

Canary and agent command:

```sh
PLAYWRIGHT_BROWSERS_PATH=.cache/setup-design-browsers ./node_modules/.bin/playwright test --config .expskill/design/playwright.config.ts
```

The Playwright web server launches the exact primary human command. Agents use the same preview method and this observer. There is no alternate renderer.

Build check:

```sh
./node_modules/.bin/vite build --config .expskill/design/vite.config.ts
```

## Context and scenario

The real target is `apps/desktop/src/renderer/features/sidebar/components/AppSidebar.tsx`. The browser renders it with React DOM and the production `SidebarProvider`, `SidebarInset` and `ProjectContextProvider`. The project context uses production `makeProjectsStore` from `apps/desktop/src/renderer/features/projects/data/project-store.ts`.

The scenario `sidebar-two-worktrees-unread` supplies projects `expand` and `docs-site`, one online local device, one offline remote device, two worktrees, read and unread conversations, fixed UUIDs and fixed timestamps. Long titles and branch names expose truncation. Project RPC methods fail explicitly if invoked; the sidebar's project read uses the real store. No backend, account or credential is connected.

The preview imports production `apps/desktop/src/renderer/index.css` through `preview.css`. Preview-only Tailwind source declarations scan the scenario and production renderer files. The Vite configuration reuses the existing React and Tailwind plugins and `@expand/desktop` alias. Actual Lucide icons and Radix controls come from production imports. Typography is the project's existing system font stack; there are no bundled font or image assets for this target.

Each browser test uses a fresh context. Its cookies and storage belong to the preview's dedicated loopback origin. The baseline starts light. Proof also toggles the root `dark` class to observe the production dark tokens; this does not exercise the uncommitted Appearance provider or persistence.

## Responsive inspection

The same production target and scenario were observed at all three sizes:

| Size | Requested viewport | Runtime viewport | Sidebar bounds |
|---|---|---|---|
| Compact | 390 x 700 | 390 x 700 | 288 x 700, mobile Sheet |
| Intermediate | 768 x 700 | 768 x 700 | 256 x 700, desktop sidebar |
| Wide | 980 x 700 | 980 x 700 | 256 x 700, desktop sidebar |

Compact width comes from committed `apps/desktop/test/ui/app-shell-mobile.test.tsx`. The 768px breakpoint comes from `apps/desktop/src/renderer/components/ui/use-mobile.ts`. Height 700 and wide width 980 come from `apps/desktop/src/main/security/window-options.ts`.

The observer reads `innerWidth`, `innerHeight`, document scroll width, sidebar bounds, mobile state, computed font and CSS tokens from the live browser. Document width matched viewport width at all three sizes. Screenshots show compact closed/open states, intermediate and wide expanded states, and light/dark tokens.

The compact screenshot exposes the baseline's cramped conversation pane. Setup records that inherited defect and does not change production code to conceal it.

## Approval rule

Setup proof never approves a feature candidate. A later production UI candidate requires an explicit decision from the human or authorized delegated reviewer, tied to the actual candidate revision and its reviewable preview evidence.

Show every intended route, state and interaction for that candidate. Future production UI review must include 320px and 390px narrow layouts, the 768px breakpoint and desktop coverage. Carry the preserved sidebar/theme work into that candidate and verify its mobile width, resizing, footer placement, drawer dismissal and motion, global automations entry, blue accents, dark default and Appearance control. Record whether each approval is a human decision or a delegated AI decision.

## Ownership

The setup owns `.expskill/setup-design.md` and these support files:

- `.expskill/design/index.html`
- `.expskill/design/main.tsx`
- `.expskill/design/preview.css`
- `.expskill/design/vite.config.ts`
- `.expskill/design/playwright.config.ts`
- `.expskill/design/proof.spec.ts`
- `.expskill/design/scenarios/sidebar-two-worktrees-unread.tsx`

There are no dependency, lockfile, production source or production configuration changes. Production modules must not import preview or scenario modules.

Generated ownership includes the isolated worktree's `node_modules/`, `.cache/setup-design-browsers/`, `.tmp/design-preview/` and `.tmp/setup-design-proof/`. The original checkout's `.tmp/setup-design-preserved/manifest.json` records hashes of all 34 original dirty files for preservation checks. Do not stage generated files or credentials.

The delegated reviewer explicitly requested that screenshots and runtime observations remain available until they review the returned evidence. Retain those ignored artifacts and the isolated worktree until that review, then remove temporary proof files as the setup skill requires. Remove temporary check configurations and build output after recording results. Clean the isolated branch/worktree only after its approved support commit has been safely integrated and the evidence retention request has been satisfied. Preserve all unrelated work throughout cleanup.

## Proof

Proof ran on 2026-10-08 against production baseline `17379ca2f3a2299f99fc5f27c99bb5197fd11a62`. The seven support files have aggregate SHA-256 digest `163a9c733c1f5de6ebe385470c321527e2f95b6f97c8ff25d06e51f107ad2a6b`, computed from sorted root-relative paths and each file's SHA-256.

The seed command succeeded and left package manifests and lockfile unchanged. Matching Chromium installation succeeded. Playwright downloaded its Ubuntu 24.04 fallback because this Linux distribution is not officially supported. Runtime proof succeeded on this machine despite that support limit.

The Vite build passed. The exact primary human command started successfully through Playwright's web server. The canary/agent command passed all 3 tests in 13.8 seconds. All three observed viewports matched their requested sizes. The real project/device/conversation controls rendered, unread filtering changed the visible conversations and project selection changed the active project. Browser error arrays were empty at every size. Production light sidebar-primary was `oklch(0.205 0 0)` and dark sidebar-primary was `oklch(0.488 0.243 264.376)`.

Targeted support lint passed with the repository's `local/module-order` and `local/no-export-star` rules. Targeted TypeScript checking passed with the workspace compiler settings and Vite client types. These checks used temporary configurations under `.tmp/setup-design-proof/` to include hidden preview files; they are separate from the full project checks.

Screenshots and observations are under `.tmp/setup-design-proof/results/proof-compact-real-sidebar-with-production-context/`, `proof-intermediate-real-sidebar-with-production-context/` and `proof-wide-real-sidebar-with-production-context/`. Each contains `light.png`, `dark.png` and `observations.json`; compact also contains `closed.png`. The complete test report is `.tmp/setup-design-proof/results.json`. The coordinator inspected compact and intermediate light screenshots and the wide dark screenshot. No required canary or size observation failed or was skipped.

## Limitations

This proof covers only fixture rendering, the stated sidebar interactions, production CSS compilation and browser observation. It does not prove backend behavior, persistence, Electron IPC, packaged hash-route reloads, live ACP compatibility, GitHub or other providers, or full accessibility and visual regression coverage.

The clean baseline lacks the original worktree's uncommitted theme provider, dark-default initialization, resizing, global automations entry, label removal and drawer corrections. Canary proof cannot validate those changes. Compact layout remains cramped in the baseline screenshot. No assistant/responsibilities UI candidate exists or has been approved through this setup.

The isolated npm install reported 15 vulnerabilities in the unchanged dependency tree: 12 moderate, 2 high and 1 critical. Setup did not alter dependencies or resolve the audit. The known architecture/package-manager and packaged route-reload blockers remain for the owning implementation workflow to verify and address.

## Reopening

An ordinary `$setup-design` invocation reads this tracked record without edits, drift checks, proof runs, commits or publication. Only an explicit update, repair or reconfigure request reopens it. Invalid records require explicit repair or reconfigure intent.

Changing the proved target, context, commands, dependencies, sizes, method or approval conditions requires a revised confirmed proposal and affected proof. Preserve the distinction between setup readiness and later production UI approval.
