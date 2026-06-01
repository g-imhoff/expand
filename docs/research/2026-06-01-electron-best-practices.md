# Yodea Desktop Architecture Redesign — Definitive Research Report

**Lead architect report · 2026-06-01 · Electron 42 / electron-vite 5 / React 19 / Effect 4.0.0-beta.74**

> Produced by a fan-out research workflow: 8 dimensions web-researched in parallel, each dimension's
> version/security-sensitive claims independently re-verified by adversarial agents, then synthesized.
> The centerpiece API (`RpcClient.makeNoSerialization` / `RpcServer.makeNoSerialization`) was
> additionally spot-checked by the orchestrator against the installed source
> (`node_modules/effect/dist/unstable/rpc/{RpcClient,RpcServer}.d.ts`) on 2026-06-01 — it exists with
> the signatures described in §3, and `onFromClient` does carry the `discard` flag noted there.

Conventions: each recommendation is tagged **[confidence: high/medium/low]** and **[CITED]** (grounded in a primary source) or **[SYNTHESIS]** (architectural judgment). Where a verified verdict refuted or corrected the supplied research, the correction is used. API names below were checked against the installed source at `node_modules/effect/.../unstable/rpc/*` and the repo's own files; where a name is still uncertain it says "verify against the installed `.d.ts` during planning."

---

## 1. Executive summary — highest-leverage moves, in priority order

1. **Project the existing `YodeaRpcs` Effect Schema contract across the IPC seam via `RpcClient.makeNoSerialization` (renderer) ↔ `RpcServer.makeNoSerialization` (main) over a thin MessagePort transport.** This deletes all 4 hand-mirrored files and is the single biggest structural win. **[SYNTHESIS, high]**
2. **Flip `sandbox:false` → `sandbox:true`, but in the SAME change convert the preload build output to CommonJS** (a sandboxed preload cannot be ESM on Electron 42). Skipping the format flip silently yields `window.yodea === undefined`. **[CITED, high]**
3. **Move `runtime.dispose()` off `window-all-closed` onto a single `before-quit` teardown,** and stop re-registering global `ipcMain.handle` per window (it throws on the 2nd window). The current `ipc.ts` has a multi-window crash and a leaked push-fiber-per-window. **[CITED, high]**
4. **Add a strict CSP and lock down navigation/window-open** (`will-navigate` deny + `setWindowOpenHandler(() => ({action:'deny'}))`). There is zero CSP today. **[CITED, high]**
5. **Replace the bespoke `useProjects` seed/push race hook with a server-state cache fed by the contract's `Events` stream** — TanStack Query *today*, effect-atom *later* (it is pinned to Effect v3 and cannot be installed on this repo yet). **[CITED, high]**
6. **Introduce a router + project-workspace shell** (`/` picker → `/p/:projectId/*` workspace); keep single-window-with-switcher, defer window-per-project. **[SYNTHESIS, high]**
7. **Adopt a feature-folder structure** in main/preload/renderer and point dependency-cruiser at the new `renderer/features/**` tree so I-1 scales with folders. **[SYNTHESIS, medium]**
8. **Pick Playwright `_electron.launch` for E2E (NOT `connectOverCDP` against :9222)** and pin Electron+Playwright behind a CI launch smoke test — `_electron.launch` is currently fragile on Electron 30+. Keep :9222 reserved for the AI agent. **[CITED, medium]**

---

## 2. Per-dimension findings

### 2.1 Security & process model
**Best practice [CITED]:** Electron 42's checklist is `contextIsolation:true` + `nodeIntegration:false` + `sandbox:true`, a strict renderer CSP delivered as a response header (not only `<meta>`), custom-protocol serving instead of `file://`, navigation/window-open lockdown, IPC sender validation, and hardened Fuses at package time (`runAsNode`/`nodeOptions`/`nodeCliInspect` OFF — all three default *enabled* in released binaries). Sources: electronjs.org/docs/latest/tutorial/{security,sandbox,fuses,esm}.

**Apply to Yodea:** Yodea's window is already a near-textbook fit *because* I-1 keeps all Node/`ws`/the RPC connection in main — the renderer needs no Node and no `ws://`, so `sandbox:true` and a tight CSP (no `connect-src` for websockets) cost almost nothing.

**Change in skeleton:** `index.ts:27` is the only deviation (`sandbox:false`). The verified correction is critical: flipping it requires the preload to be **CommonJS** because the preload is currently emitted as `out/preload/index.mjs` and Electron 42 runs sandboxed preloads "as plain JavaScript without an ESM context" — a sandboxed `.mjs` preload's top-level `import` fails and `contextBridge.exposeInMainWorld` never runs. Do both in one change.

### 2.2 Typed IPC
**Best practice [CITED]:** "One generic bridge + a derived typed client," not per-channel methods (electron-trpc's `exposeElectronTRPC()` + `ipcLink`). Source: electron-trpc.dev.

**Apply to Yodea:** Yodea owns a *stronger* native asset than tRPC — `YodeaRpcs` is already a pure Effect Schema `RpcGroup`. Adopting tRPC would introduce a second, competing contract system. Instead, derive the client from `YodeaRpcs`. See §3.

**Change in skeleton:** delete `api.d.ts` (the contract types *are* the bridge types); collapse `project:list/create/changed` into one transport; the renderer imports only `@yodea/contracts` + `effect/unstable/rpc` — never `@yodea/client-core`.

### 2.3 Renderer state
**Best practice [CITED]:** server-state cache (TanStack Query) for reads/writes + one app-root subscription folding pushes into the cache via `setQueryData`; client UI state separate (Zustand/Jotai); React 19 `use()` is sugar over a cache, never a fetch mechanism.

**Apply to Yodea — verified blocking fact:** effect-atom (`@effect-atom/atom@0.5.3`, `atom-react@0.5.0`) peers on **`effect@^3.19`** and the old split `@effect/*` packages — it is **not installable on `effect@4.0.0-beta.74`**. So effect-atom is the *strategic target*, not today's choice. Use **TanStack Query v5 now**, with a thin Effect-core wrapper at the `window.yodea` edge, `staleTime: Infinity` for push-backed keys, and migrate to effect-atom when a v4 build ships. Re-check `registry.npmjs.org/@effect-atom/atom/latest` for a 4.x range during planning.

**Change in skeleton:** `use-projects.ts`'s manual `applied` race flag disappears: the query is the canonical seed, `Events`/`ProjectList` fold forward into the same cache key. Reading the bridge via `globalThis` (line 85) disappears once the bridge type is derived from the contract under the renderer's own DOM tsconfig.

### 2.4 Structure
**Best practice [CITED]:** feature-folder organization in all three processes; thin per-feature main modules over a reusable service layer; multi-window via `rollupOptions.input` named entries.

**Apply to Yodea:** Yodea's "service layer" is already `client-core` (`ProjectStore` *is* the project service), so **main stays thin** — an Effect-runtime host + RPC transport, not a place to re-implement domain logic. See §4.

**Change in skeleton:** grow `main/` to `index + runtime + rpc/ + features/<feature>/`; `features/` in main appears only for Electron-process capability the backend doesn't own (menus, dialogs, tray, deep links). Note `electron.vite.config.ts` uses the **deprecated** `externalizeDepsPlugin()` — electron-vite 5 moved this to `build.externalizeDeps` (on by default). Refresh it alongside the preload-format work; for the sandboxed preload you need `externalizeDeps:false` so it bundles to a single file.

### 2.5 Streaming
**Best practice [CITED] with corrections:** two tiers — `webContents.send`/`ipcRenderer.on` for low volume, `MessageChannelMain` + `webContents.postMessage([port])` for high-volume/many-subscriber duplex streaming with natural per-window teardown. **Two verified corrections to the supplied research:**
- Sends to a **destroyed** webContents do **not** silently drop — they commonly **throw** `'Object has been destroyed'`. Sends to a **not-yet-loaded** renderer *are* silently dropped. So guard with `isDestroyed()`/try-catch **and** gate first push on `did-finish-load`.
- `ipcMain.handle` enforces one-handler-per-channel and **throws** on the second registration (confirmed in Electron 42 source `lib/browser/ipc-main-impl.ts`). Use **`win.webContents.ipc.handle(...)`** (a per-WebContents `IpcMain`, auto-torn-down) for per-window handlers, OR register global handlers once at `app.whenReady()`.

**Apply to Yodea:** the ad-hoc `project:changed` channel becomes the contract's `Events`/`Connect` streams. Keep ONE app-scoped `ManagedRuntime`+`ProjectStore`; make subscriptions per-WebContents, scoped to the window, interrupted on BOTH `'closed'` AND `'render-process-gone'`.

**Change in skeleton:** `ipc.ts` forks an unguarded, never-interrupted push fiber bound to a captured `webContents`, and registers global handlers inside `createWindow` — both are latent bugs that only "work" because the app is single-window today.

### 2.6 App shell & UX
**Best practice [CITED]:** single-window-with-switcher is the default for project-centric editors (Zed, Linear, Obsidian); window-per-project is an explicit user-invoked escape hatch; per-project state lives in the privileged main process, not renderer localStorage (which races across windows). Native shell = custom titlebar (`titleBarStyle:'hidden'` + `titleBarOverlay:{color,symbolColor,height}`, `app-region:drag`), native `Menu`, command palette, deep links via custom protocol + `requestSingleInstanceLock`.

**Apply to Yodea:** treat "project" as a **route, not a window**. Deep link `yodea://project/<id>` maps onto `/p/:projectId`. See §5.

**Change in skeleton:** the single inline `App.tsx` becomes a routed shell.

### 2.7 Testing
**Best practice [CITED] with corrections:** Playwright `_electron.launch` is the better fit for native-ESM/electron-vite (WebdriverIO is the documented fallback with better Electron-API mocking). **Corrections:** the Electron docs do **not** "recommend WebdriverIO over Playwright" — they list options as equal. And `_electron.launch` is **currently fragile on Electron 30+**: it injects `--remote-debugging-port=0` as a CLI arg, which Electron 30+ rejects; the Jan-2026 fix (#39012) was **reverted** (#39710, 2026-03-16) and the follow-up (#39922) closed `not_planned`. So you MUST pin and gate.

**Apply to Yodea:** keep the DI'd-`ipc.ts`-under-Bun pattern as the **primary** tier and extend it to the new typed-IPC layer. See §7.

**Change in skeleton:** add a typed-contract round-trip test (the highest-value new test); reserve :9222 for the AI agent.

### 2.8 Effect-in-Electron
**Best practice [CITED + verified]:** one long-lived `ManagedRuntime` in main, disposed once at app shutdown via `runtime.dispose()`. **Verified in this repo's `node_modules`:** Effect v4 folded RPC into core at `effect/unstable/rpc`, Schema drives serialization — so the same contract can drive IPC.

**Apply to Yodea:** keep `runtime.ts` as-is structurally; move disposal to `before-quit`. Electron IPC uses the **Structured Clone Algorithm, which strips prototype chains** — so `Project`/`DomainEvent` class instances arrive on the renderer as plain objects, making **renderer-side Schema decode mandatory** (it's also what restores types). Cross the bridge as the **encoded message object** (plain JSON), decode with the contract Schema in the renderer.

---

## 3. The typed IPC seam (CENTERPIECE)

### 3.1 The problem
`YodeaRpcs` (`packages/contracts/rpc.ts`) is a typed `RpcGroup` with both request/response (`Health`, `ProjectCreate`, `ProjectList`) and streams (`Connect`, `Events` — both `stream: true`). At the IPC edge it's **thrown away** and re-typed by hand across four files: `main/ipc.ts`, `preload/index.ts`, `preload/api.d.ts`, `renderer/use-projects.ts`. Adding a feature today means editing all four; nothing guards them against drift.

### 3.2 Options considered

| Option | Verdict |
|---|---|
| **A. Adopt electron-trpc / trpc-electron** | **Reject.** Introduces a *second* contract system competing with `YodeaRpcs`, is not Effect-native, and the v11 fork situation is fragile. Yodea already owns a better primitive. **[CITED]** |
| **B. Hand-rolled generic `invoke(tag, payload)` + `subscribe(tag, payload, cb)`** | Workable fallback. Less moving parts, but you re-implement request/response correlation, streaming chunk framing, and acks that Effect RPC already provides — i.e. you'd hand-roll what `RpcClient` gives you. **[SYNTHESIS]** |
| **C. `makeProtocolWorker` / `makeProtocolWorkerRunner`** | Real and shipped (verified at `RpcClient.ts:1207`/`RpcServer.ts:1354`), but requires writing a `Worker.WorkerPlatform` + `Worker.Spawner` adapter (and a `WorkerRunnerPlatform`) for Electron's `MessagePortMain` (which is `EventEmitter`-based, not a Web `Worker`). Heavier than needed. **[CITED]** |
| **D. `RpcClient.makeNoSerialization` ↔ `RpcServer.makeNoSerialization` over a thin transport** | **Recommended.** The cleanest seam — see below. **[SYNTHESIS, high]** |

### 3.3 Recommended design (Option D)

**Why D:** verified in `node_modules/effect/.../unstable/rpc/` that both sides expose a `makeNoSerialization` constructor that *is* the transport seam:

- **Client** (`RpcClient.d.ts:92`): `makeNoSerialization(group, { onFromClient: ({message, context, discard}) => Effect<void, E> })` returns `Effect<{ client, write }, never, Scope>`. You implement `onFromClient` to **push** a message out over the port; you call the returned `write(serverMessage)` to **feed** inbound messages in. The `client` is the fully typed `RpcClient<Rpcs>` — `client.ProjectList()` → `Effect`, `client.Events()` → `Stream` (stream-ness is derived from the `RpcSchema.Stream` success schema, not a literal option).
- **Server** (`RpcServer.d.ts:37`): `makeNoSerialization(group, { onFromServer: (response) => Effect<void> })` is the mirror — `onFromServer` pushes responses out; it consumes client messages through its handler layer (`Rpc.ToHandler<Rpcs>`).

This means **Yodea does not write an `RpcClient.Protocol` from scratch and does not need the Worker platform**. It writes two tiny callbacks wiring the message objects to a port. Electron's IPC does the structured-clone serialization; the messages are plain JSON-shaped objects (`FromClient`/`FromServer`), so they cross the bridge cleanly.

**Transport choice:** a per-window `MessageChannelMain` port (preferred for duplex streaming + free teardown), OR a generic two-channel `ipcRenderer.invoke`/`on` pair (simpler, fine to start). Start with whichever the team prefers; the `makeNoSerialization` seam is transport-agnostic.

> Verify against the installed `.d.ts` during planning: the `onFromClient` `discard` flag **does** exist and must be honored (confirmed); also confirm the exact shape of `FromClient`/`FromServer` and how `supportsAck` interacts with the port. Stable enough to design against, but pin before coding.

### 3.4 Layering sketch

```
┌─ packages/contracts (PURE) ─────────────────────────────────────────┐
│  YodeaRpcs: RpcGroup<Health, ProjectCreate, ProjectList, Connect, Events>
│  (the SINGLE source of truth — used by backend WS AND main↔renderer IPC)
└──────────────────────────────────────────────────────────────────────┘
        ▲ imported by main                       ▲ imported by renderer (allowed: pure)

MAIN (privileged)                          RENDERER (pure, I-1)
─────────────────                          ────────────────────
RpcServer.makeNoSerialization(YodeaRpcs, { RpcClient.makeNoSerialization(YodeaRpcs, {
  onFromServer: msg =>                        onFromClient: ({message}) =>
    Effect.sync(() => port.postMessage(msg)) })  Effect.sync(() => port.postMessage(message)) })
  handlers delegate to ProjectStore:        → { client, write }
   - ProjectList → SubscriptionRef.get      port.onmessage = e => runtime.runFork(write(e.data))
   - ProjectCreate → store.createProject
   - Events/Connect → existing streams      client.ProjectList() : Effect<Project[]>
port.onmessage → server.write(e.data)        client.Events()     : Stream<DomainEvent>
                                            (Schema decode happens INSIDE RpcClient)

         PRELOAD (sandboxed, CJS): exposes ONE thing — the transferred MessagePort
         (or generic invoke/subscribe). NO per-feature methods. api.d.ts DELETED.
```

**I-1 — verified caveat that corrects the supplied research:** the research initially claimed "the router type crosses as a type-only import, so I-1 holds." That reasoning is **wrong for this repo**: `.dependency-cruiser.cjs` sets `tsPreCompilationDeps: true`, under which forbidden rules **do** trigger on `import type`. The `renderer-must-not-import-client-core` rule has no `dependencyTypesNot: ["type-only"]` exemption. **Therefore the renderer/preload must source RPC types ONLY from `@yodea/contracts` + npm `effect/unstable/rpc`, never any type from `@yodea/client-core`.** Reconstruct the client type renderer-side as `RpcClient<typeof YodeaRpcs.Rpcs>` (verify exact type accessor against the installed `.d.ts`). Add a positive dependency-cruiser rule: renderer MAY import `@yodea/contracts` and `effect/unstable/rpc`, MUST NOT import `@yodea/client-core`/main/Node/`ws`.

**Effect runtime in the renderer:** the derived `client` needs *an* Effect runtime to run the client Effects/Streams. This is acceptable and stays I-1-clean because the renderer runtime provides **zero Node services** — only the pure `RpcClient.Protocol` (the `makeNoSerialization` result) + Schema. This is a genuine fork to confirm in §8: a small renderer `ManagedRuntime` (cleanest, fully Effect-first) vs keeping the renderer Effect-light behind a Promise/callback adapter.

**Error model:** today errors are stringified. Effect RPC encodes a defined `error` Schema per Rpc; enrich `ProjectCreate` etc. with tagged errors so the renderer surfaces a discriminated `Effect<…, ProjectCreateError>` instead of `message(cause)`. **[SYNTHESIS, high]**

---

## 4. Recommended target folder structure for `apps/desktop`

```
apps/desktop/
├─ electron.vite.config.ts        # refresh to electron-vite 5 (build.externalizeDeps); preload → CJS, externalizeDeps:false
└─ src/
   ├─ main/
   │  ├─ index.ts                 # Electron bootstrap + window lifecycle ONLY; dispose runtime on before-quit
   │  ├─ runtime.ts               # the ONE ManagedRuntime<ProjectStore> (keep)
   │  ├─ security/
   │  │  ├─ harden-web-contents.ts# will-navigate deny + setWindowOpenHandler deny (DI'd, electron-free, unit-testable)
   │  │  └─ csp.ts                # onHeadersReceived (dev) / protocol.handle header (prod)
   │  ├─ rpc/
   │  │  ├─ server.ts             # RpcServer.makeNoSerialization(YodeaRpcs) backed by ProjectStore
   │  │  └─ transport.ts          # MessagePort wiring; per-window scope + teardown (DI'd)
   │  └─ features/                # ONLY Electron-process capabilities the backend doesn't own
   │     └─ <feature>/            # e.g. menus/, dialogs/, deep-links/, tray/
   ├─ preload/
   │  └─ index.ts                 # ONE generic surface (the port / invoke+subscribe). NO api.d.ts.
   └─ renderer/
      ├─ app/
      │  ├─ main.tsx
      │  ├─ router.tsx            # / picker, /p/:projectId/* workspace
      │  ├─ shell/                # titlebar, command palette, layout
      │  └─ providers/            # QueryClientProvider + RPC-client/event-stream context
      ├─ rpc/
      │  └─ client.ts             # RpcClient.makeNoSerialization(YodeaRpcs) over window.yodea
      ├─ features/
      │  └─ projects/             # components + hooks + this feature's query keys
      │     ├─ use-projects.ts    # TanStack Query, seeded by ProjectList + folded by Events
      │     └─ ...
      └─ shared/                  # ui primitives (no Node, no client-core)
```
**[SYNTHESIS, medium]** Point dependency-cruiser at `renderer/` (incl. `features/` and `shared/`) so I-1 scales with folders, not just the current flat files.

---

## 5. Project-centric app shell

**Recommendation: single-window-with-switcher + client-side router; defer window-per-project. [CITED + SYNTHESIS, high]** This matches Zed/Linear/Obsidian and Yodea's event-sourced backend (all projects already in one `SubscriptionRef`). Multi-window costs ~150-250MB/window and forces a cross-window sync layer you don't need yet.

- **Routing:** **TanStack Router** (fully type-safe params/search for an SPA; React Router v7's type-safety largely needs SSR/framework mode, which Yodea won't run). Routes: `/` (project picker / recent projects) and `/p/:projectId/*` (workspace shell with feature children). `projectId` is a typed param every feature reads. **[CITED, high]**
- **Selection state in the URL,** not a Zustand atom — so deep-linking, back/forward, and window-restore work. Reserve a small client store for truly ephemeral UI (panel open/closed, form drafts). **[CITED, high]**
- **State ownership:** ONE main-process `ManagedRuntime` + `ProjectStore` is the single source of truth across all windows/routes; per-route/per-window subscriptions are the unit that comes and goes. **Recent-projects + per-project layout persist in main** (SQLite/electron-store), exposed over RPC — never renderer localStorage. **[CITED, high]**
- **Native shell:** application `Menu` in main (items fire typed RPCs/navigation over the one transport — never new ad-hoc channels); command palette in the renderer; define both from one shared command registry to avoid drift. Custom titlebar via `titleBarStyle:'hidden'` + `titleBarOverlay:{color,symbolColor,height}` + `app-region:drag` if/when you want native chrome. **[CITED, medium]**
- **When to split a window:** only for genuinely independent surfaces (settings, a detached log/inspector, or eventually a second project) — and even then it attaches to the SAME main runtime, never a second RPC client. **[SYNTHESIS, high]**

---

## 6. Security checklist for Yodea (Electron 42)

| Item | Current | Recommendation | Conf. |
|---|---|---|---|
| `contextIsolation` | `true` ✓ | keep `true` | CITED, high |
| `nodeIntegration` | `false` ✓ | keep `false` | CITED, high |
| **`sandbox`** | **`false`** | **`true`** — re-examined below | CITED, high |
| **Preload format** | `.mjs` (ESM) | **CommonJS** (`build.externalizeDeps:false`, single bundle) — required by the sandbox flip | CITED, high |
| **CSP** | none | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` — via `onHeadersReceived` (dev) and a `protocol.handle('app://')` response header (prod). `connect-src 'self'` is fine: the renderer never opens a socket, main does. | CITED, high |
| **Navigation lockdown** | none | `will-navigate` → `preventDefault()` unless origin is dev renderer / `app://`; `setWindowOpenHandler(() => ({action:'deny'}))`. Put in a DI'd `hardenWebContents(win)`. | CITED, high |
| **Prod renderer delivery** | `loadFile` (`file://`) | `protocol.handle('app://')` so the CSP is a real header and `grantFileProtocolExtraPrivileges=false` is clean. (Open decision — extra main plumbing.) | CITED, medium |
| **IPC sender validation** | none | reject untrusted `event.senderFrame` origin; inject a `senderAllowed` predicate through `IpcDeps` to keep the module electron-free. | CITED, medium |
| **Fuses** (package time) | n/a (no build yet) | `RunAsNode=false`, `EnableNodeOptionsEnvironmentVariable=false`, `EnableNodeCliInspectArguments=false`, `EnableCookieEncryption=true`, `GrantFileProtocolExtraPrivileges=false`; asar integrity on once asar exists. Verify in CI with `@electron/fuses read`. | CITED, high |
| **CDP `:9222`** | `!app.isPackaged` gate ✓ | keep gate; add explicit `YODEA_DEVTOOLS_CDP==='1'` opt-in so a normal dev session doesn't leave an attachable port open. Loopback is not an auth boundary. | CITED, medium |

**The `sandbox:false` decision, explicitly re-examined [CITED, high]:** There is **no legitimate reason** for Yodea to keep `sandbox:false`. I-1 already forbids Node in the renderer; all `ws`/Node/Bun live in main. A sandboxed preload retains exactly what Yodea's preload uses — `contextBridge`, `ipcRenderer` (+ `crashReporter`, `nativeImage`, `webFrame`, `webUtils`, `events`/`timers`/`url`, `Buffer`/`process`). The verified MessagePort path is also sandbox-safe: a live port is **not** passed *through* `contextBridge` (which only copies plain values); instead the preload receives it via `ipcRenderer.on('...', e => e.ports[0])` and transfers it to the main world with native `window.postMessage(msg, '*', [port])`. **The one hard prerequisite (verified correction to the supplied research):** the preload must be **CommonJS**, because Electron 42 runs sandboxed preloads with no ESM context — a sandboxed `.mjs` preload silently breaks (`window.yodea` undefined). **Recommendation: flip `sandbox:true` and convert ONLY the preload to CJS in the same change.** Main and renderer stay native ESM. (Note: contrary to one supplied claim, `contextIsolation:true` does not "silently forfeit" the sandbox — `sandbox:false` is an explicit, direct opt-out on `index.ts:27`.)

---

## 7. Testing strategy

**Tier 1 — Unit (primary investment) [CITED, high].** The DI'd `ipc.ts` tested under Bun+Vitest with no `electron` import is the correct modern pattern; the official Electron testing page offers nothing better. Extend it to the new `rpc/server.ts` + `rpc/transport.ts`: unit-test encode/decode/dispatch against a fake port/`write` and a real in-memory `ProjectStore`. This catches contract drift without spawning Electron.

**Tier 1b — Typed-contract round-trip test (highest-value new test) [CITED, high].** One test that takes a contract request, round-trips it renderer→main→`ProjectStore`→back, and asserts the renderer receives the Schema-validated shape. This is the test that justifies the whole typed-IPC redesign and prevents drift.

**Tier 2 — Renderer component [CITED, high].** Honor I-1: never import `client-core`/Node. Inject a fake `window.yodea` (or fake port) in a Vitest `setupFile`; test components + the projects hook against the bridge contract. jsdom now; migrate to **Vitest 4 Browser Mode + vitest-browser-react** as the workspace UI grows (its Playwright provider reuses your E2E browser). Keep dependency-cruiser in test scope so a fixture can't sneak a Node import in.

**Tier 3 — E2E: Playwright `_electron.launch`, NOT `connectOverCDP(:9222)` [CITED, medium].** Verified facts: `_electron.launch` spawns its *own* isolated Electron (its own `--remote-debugging-port=0`, discovered from stderr over WebSocket — *not* a stdio pipe, correcting the supplied research), so **:9222 is the wrong attach point and must stay reserved for the AI agent**. Use `_electron.launch({ args: ['out/main/index.mjs'], executablePath })` + electron-playwright-helpers (`findLatestBuild`, `ipcMainInvokeHandler`). **Critical caveat:** `_electron.launch` is *currently fragile on Electron 30+* (the `--remote-debugging-port` CLI-arg rejection; the Jan-2026 fix was reverted, #39922 closed `not_planned`). **Pin Electron 42.x + Playwright ≥1.60, add a CI launch smoke test on Linux with `xvfb-run`, and be ready with a `commandLine.appendSwitch` workaround.** WebdriverIO + `wdio-electron-service` is the documented fallback if you later need its dialog/menu mocking — not the default. Optionally add a tiny separate smoke test that the AI agent can still attach to :9222 after the redesign.

---

## 8. Open decisions for the brainstorming session

1. **Effect runtime in the renderer?** Small renderer `ManagedRuntime` + `RpcClient` (cleanest, fully Effect-first, thickens the "thin shell" slightly) **vs** renderer Effect-light behind a Promise/callback preload adapter (RPC client runs in main). Both satisfy I-1; they differ in where the runtime lives. *This is the single biggest architectural fork.*
2. **Transport:** native `MessageChannelMain` port (best long-term streaming substrate, needs reload re-handshake logic) **vs** generic `invoke`/`subscribe` over `ipcMain.handle` + one push channel (simpler now, migrate later). Both work with `makeNoSerialization`.
3. **RPC integration depth:** `makeNoSerialization` seam (recommended — minimal) **vs** full `makeProtocolWorker`/`WorkerRunner` adapter (more machinery) **vs** hand-rolled generic relay (fewest Effect-RPC features). Confirm the team accepts depending on an *unstable* v4 module (`effect/unstable/rpc` may break in minor releases).
4. **Renderer server-state library:** TanStack Query **now** (effect-atom is blocked on Effect v3) — and migrate to effect-atom when a v4 build ships **vs** build a tiny in-house "atom-lite" (Registry of `SubscriptionRef`s via `useSyncExternalStore`) to stay 100% Effect-first today.
5. **Error model:** enrich `YodeaRpcs` commands with typed Schema errors now (discriminated tags propagate to the renderer) **vs** keep coarse until specific failure UX is needed.
6. **Stream validation policy:** re-decode every `Events` chunk in the renderer (defense-in-depth, the "tax") **vs** trust main (already validated against the backend) and validate only renderer→main commands.
7. **Push payload shape:** full reconciled snapshots (simple, great for small collections; what `ProjectStore` already produces) **vs** lightweight "changed" events + `invalidateQueries` (scales to high-frequency streams). Which `YodeaRpcs` streams are high-frequency?
8. **Multi-window roadmap:** is window-per-project / side-by-side a near-term need (design cross-window sync now) or is in-app routing sufficient (defer `rollupOptions.input` multi-entry)?
9. **Prod renderer delivery:** move from `loadFile`/`file://` to `protocol.handle('app://')` (official rec; clean header-based CSP) — confirm before designing the prod load path.
10. **Packager:** electron-builder vs Electron Forge — determines how Fuses + asar integrity get wired.
11. **Backend restart UX:** silent auto-reconnect + re-seed vs an explicit "reconnecting" banner. This drives whether connection-state becomes a first-class observable in the contract; reconnection logic must live in `client-core`, not the renderer.
12. **Persistence home:** recent-projects / per-project layout in the event-sourced SQLite backend (syncs across frontends, becomes domain events) vs desktop-local electron-store (UI state, arguably not a domain event).
13. **Custom protocol grammar:** confirm `yodea://project/<id>` (+ future `…/<feature>/<entity>`) and whether deep links may cold-launch the app (needs `requestSingleInstanceLock` first) or only focus a running instance.

---

## 9. Sources (deduped, with dates)

**Electron official docs (fetched/verified 2026-06-01, Electron 42 / v42.2.0–42.3.0):**
- Security checklist — https://www.electronjs.org/docs/latest/tutorial/security
- Process Sandboxing — https://www.electronjs.org/docs/latest/tutorial/sandbox
- ES Modules (ESM) in Electron (sandboxed preloads run as plain JS, no ESM context) — https://www.electronjs.org/docs/latest/tutorial/esm
- Electron Fuses (v42.3.0 defaults) — https://www.electronjs.org/docs/latest/tutorial/fuses
- Inter-Process Communication — https://www.electronjs.org/docs/latest/tutorial/ipc
- MessagePorts in Electron — https://www.electronjs.org/docs/latest/tutorial/message-ports
- webContents (send/postMessage/isDestroyed/'destroyed'/'render-process-gone') — https://www.electronjs.org/docs/latest/api/web-contents
- MessageChannelMain / MessagePortMain — https://www.electronjs.org/docs/latest/api/message-channel-main · /api/message-port-main
- contextBridge (structured-clone value constraints) — https://www.electronjs.org/docs/latest/api/context-bridge
- Custom Title Bar / Window Customization — https://www.electronjs.org/docs/latest/tutorial/custom-title-bar · /tutorial/window-customization
- Deep Links — https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app
- Automated Testing — https://www.electronjs.org/docs/latest/tutorial/automated-testing
- Electron 42.0.0 blog (released 2026-05-07; Chromium 148, Node 24.15.0, V8 14.8) — https://www.electronjs.org/blog/electron-42-0
- runAsNode CVEs statement — https://www.electronjs.org/blog/statement-run-as-node-cves
- IPC v8 structured-clone refactor — PR #20214 — https://github.com/electron/electron/pull/20214
- `ipcMain.handle` duplicate-handler throw + `webContents.ipc` (verified at v42.0.0 source) — https://github.com/electron/electron/blob/v42.0.0/lib/browser/ipc-main-impl.ts
- CVE-2026-34780 (contextBridge VideoFrame; patched pre-42) — https://github.com/electron/electron/security/advisories/GHSA-jfqg-hf23-qpw2

**electron-vite (5.0, released 2025-12-07):**
- Config / Dev / Build / Dependency Handling — https://electron-vite.org/config/ · /guide/dev · /guide/build · /guide/dependency-handling
- 5.0 release blog — https://electron-vite.org/blog/
- sandbox:true preload discussion #423 — https://github.com/alex8088/electron-vite/discussions/423

**Effect v4 (verified against installed `effect@4.0.0-beta.74` in repo `node_modules`, 2026-06-01):**
- `RpcClient.makeNoSerialization` (`RpcClient.d.ts:92`), `makeProtocolWorker` (~1207) — `node_modules/effect/.../unstable/rpc/RpcClient.{d.ts,ts}`
- `RpcServer.makeNoSerialization` (`RpcServer.d.ts:37`), `makeProtocolWorkerRunner` (~1354), `layerProtocolWebsocket`/`Stdio` — `node_modules/effect/.../unstable/rpc/RpcServer.{d.ts,ts}`
- `RpcSerialization.layerNdjson`/`layerJson`/`layerMsgPack` — `node_modules/effect/.../unstable/rpc/RpcSerialization.ts`
- `Worker.WorkerPlatform`/`Spawner` tags — `node_modules/effect/.../unstable/workers/Worker.ts`
- `packages/contracts/rpc.ts` (the `YodeaRpcs` group)
- Effect v4 Beta recap — https://effect.website/blog/effect-v4beta-launch-to-may-recap/ · InfoQ (2026-04-18) https://www.infoq.com/news/2026/04/effect-v4-beta/
- Runtime / ManagedRuntime docs — https://effect.website/docs/runtime/

**Renderer state / routing / React:**
- effect-atom (peers Effect v3 — blocked here; `@effect-atom/atom@0.5.3` 2026-02-25) — https://registry.npmjs.org/@effect-atom/atom/latest · https://github.com/tim-smart/effect-atom
- TanStack Query streamedQuery (experimental) — https://tanstack.com/query/v5/docs/reference/streamedQuery
- TkDodo, WebSockets with React Query — https://tkdodo.eu/blog/using-web-sockets-with-react-query
- React 19 `use()` — https://react.dev/reference/react/use
- `useSyncExternalStore` — https://react.dev/reference/react/useSyncExternalStore
- TanStack Router vs React Router v7 (2026) — https://www.pkgpulse.com/blog/tanstack-router-vs-react-router-v7-2026

**Typed IPC / shell prior art:**
- electron-trpc — https://github.com/jsonnull/electron-trpc · https://electron-trpc.dev/ · trpc-electron fork — https://github.com/mat-sz/trpc-electron
- Zed Windows & Projects — https://zed.dev/docs/windows-and-projects
- Multi-window in Electron (2025-07-21) — https://blog.bloomca.me/2025/07/21/multi-window-in-electron.html

**Testing:**
- Playwright Electron class (experimental) — https://playwright.dev/docs/api/class-electron
- `_electron.launch` Electron 30+ regression #39008 / revert #39710 / #39922 — https://github.com/microsoft/playwright/issues/39008 · /pull/39710 · /issues/39922
- Electron 36 launch failure #47419 — https://github.com/electron/electron/issues/47419
- wdio-electron-service (v9.2.1, 2025-10-24) — https://github.com/webdriverio-community/wdio-electron-service
- electron-playwright-helpers — https://github.com/spaceagetv/electron-playwright-helpers
- Vitest Browser Mode (stable in Vitest 4) — https://vitest.dev/guide/browser/component-testing

**dependency-cruiser (repo uses 17.4.2; type-only triggering under `tsPreCompilationDeps:true`):**
- options-reference / rules-reference — https://github.com/sverweij/dependency-cruiser/blob/main/doc/options-reference.md · /doc/rules-reference.md

**Repo files inspected:** `apps/desktop/src/{main/index.ts,main/ipc.ts,main/runtime.ts,preload/index.ts,preload/api.d.ts,renderer/use-projects.ts,renderer/App.tsx}`, `apps/desktop/electron.vite.config.ts`, `packages/contracts/rpc.ts`, `.dependency-cruiser.cjs`.
