import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { describe, expect } from "vitest"
import { parse as parseYaml } from "yaml"

const WorkflowSetupNodeWith = Schema.Struct({
  "node-version-file": Schema.String,
  cache: Schema.String
})

const WorkflowStep = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.String),
  uses: Schema.optionalKey(Schema.String),
  with: Schema.optionalKey(WorkflowSetupNodeWith)
})

const WorkflowJob = Schema.Struct({
  name: Schema.String,
  "runs-on": Schema.String,
  needs: Schema.optionalKey(Schema.String),
  "timeout-minutes": Schema.Number,
  steps: Schema.Array(WorkflowStep)
})

const Workflow = Schema.Struct({
  name: Schema.String,
  on: Schema.Struct({
    push: Schema.Struct({ branches: Schema.Array(Schema.String) }),
    pull_request: Schema.Struct({ branches: Schema.Array(Schema.String) })
  }),
  concurrency: Schema.Struct({
    group: Schema.String,
    "cancel-in-progress": Schema.Boolean
  }),
  permissions: Schema.Struct({
    contents: Schema.String
  }),
  jobs: Schema.Struct({
    checks: WorkflowJob,
    "desktop-e2e": WorkflowJob,
    "binary-smoke": WorkflowJob
  })
})

const parseWorkflow = Effect.fn("EffectPolicyTest.parseWorkflow")((source: string) =>
  Effect.try({
    try: () => parseYaml(source),
    catch: (cause) => ({ _tag: "WorkflowYamlError" as const, cause })
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Workflow, { onExcessProperty: "error" }))))

const expectedPreCommit = [
  "#!/bin/sh",
  "set -e",
  "",
  "echo \"pre-commit › eslint\"",
  "npm run lint",
  "",
  "echo \"pre-commit › typecheck\"",
  "npm run typecheck:all",
  "",
  "echo \"pre-commit › ok\"",
  ""
].join("\n")

const expectedJobCommands = {
  checks: [
    "npm ci",
    "npm run lint",
    "npm run typecheck:all",
    "npm run arch",
    "npm run knip",
    "npm run test",
    "npm run cert:packages",
    "npm run bench:selfcheck",
    "npm run bench:events -- --smoke"
  ],
  "desktop-e2e": [
    "npm ci",
    "npm exec -- playwright install-deps chromium && sudo apt-get install -y libgtk-3-0t64",
    "npm run build:desktop",
    "xvfb-run -a npm run e2e:desktop"
  ],
  "binary-smoke": [
    "npm ci",
    "npm run cert:cli:build"
  ]
} as const

const expectedWorkflow = {
  name: "CI",
  on: {
    push: {
      branches: ["develop", "feat/architectural-foundation"]
    },
    pull_request: {
      branches: ["develop", "feat/architectural-foundation"]
    }
  },
  concurrency: {
    group: "${{ github.workflow }}-${{ github.ref }}",
    "cancel-in-progress": true
  },
  permissions: {
    contents: "read"
  },
  jobs: {
    checks: {
      name: "Types, architecture invariants, tests",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 10,
      steps: [
        {
          uses: "actions/checkout@v6"
        },
        {
          uses: "actions/setup-node@v6",
          with: {
            "node-version-file": ".node-version",
            cache: "npm"
          }
        },
        {
          name: "Install dependencies (frozen lockfile)",
          run: "npm ci"
        },
        {
          name: "Lint",
          run: "npm run lint"
        },
        {
          name: "Typecheck (root + desktop projects)",
          run: "npm run typecheck:all"
        },
        {
          name: "Architecture invariant I-1 (dependency-cruiser, BOUNDARIES.md)",
          run: "npm run arch"
        },
        {
          name: "Unused dependency and export analysis",
          run: "npm run knip"
        },
        {
          name: "Unit + architecture tests",
          run: "npm run test"
        },
        {
          name: "Publish package certification",
          run: "npm run cert:packages"
        },
        {
          name: "Benchmark harness self-check",
          run: "npm run bench:selfcheck"
        },
        {
          name: "Benchmark smoke",
          run: "npm run bench:events -- --smoke"
        }
      ]
    },
    "desktop-e2e": {
      name: "Desktop e2e (serialized RPC seam, ARCHITECTURE.md §5.4)",
      "runs-on": "ubuntu-latest",
      needs: "checks",
      "timeout-minutes": 15,
      steps: [
        {
          uses: "actions/checkout@v6"
        },
        {
          uses: "actions/setup-node@v6",
          with: {
            "node-version-file": ".node-version",
            cache: "npm"
          }
        },
        {
          name: "Install dependencies (frozen lockfile)",
          run: "npm ci"
        },
        {
          name: "Electron system libraries (managed by Playwright)",
          run: "npm exec -- playwright install-deps chromium && sudo apt-get install -y libgtk-3-0t64"
        },
        {
          name: "Build desktop",
          run: "npm run build:desktop"
        },
        {
          name: "Run desktop e2e",
          run: "xvfb-run -a npm run e2e:desktop"
        }
      ]
    },
    "binary-smoke": {
      name: "Compiled-binary certification (I-4 reaping + durability)",
      "runs-on": "ubuntu-latest",
      needs: "checks",
      "timeout-minutes": 10,
      steps: [
        {
          uses: "actions/checkout@v6"
        },
        {
          uses: "actions/setup-node@v6",
          with: {
            "node-version-file": ".node-version",
            cache: "npm"
          }
        },
        {
          name: "Install dependencies (frozen lockfile)",
          run: "npm ci"
        },
        {
          name: "Build CLI/server binaries and smoke-test them",
          run: "npm run cert:cli:build"
        }
      ]
    }
  }
} as const

const expectedCodeOwners = [
  ["/docs/architecture/BOUNDARIES.md", "@g-imhoff"],
  ["/.dependency-cruiser.cjs", "@g-imhoff"],
  ["/test/architecture/", "@g-imhoff"],
  ["/docs/architecture/EFFECT_ONLY.md", "@g-imhoff"],
  ["/tsconfig.workspace.json", "@g-imhoff"],
  ["/eslint.effect.config.mjs", "@g-imhoff"],
  ["/eslint-rules/effect-*", "@g-imhoff"],
  ["/scripts/effect-*", "@g-imhoff"]
] as const

const expectedPolicyHeadings = [
  "Effect-only boundary",
  "Pure code stays pure",
  "Required Effect shapes",
  "Host adapters and runners",
  "Commands",
  "Permanent ratchets",
  "Completion"
] as const

const expectedPureRules = [
  "The boundary is a functional core around an effectful shell: total deterministic calculations stay ordinary functions, while effectful behavior is represented by Effect, Stream, Layer, or a service.",
  "Pure code receives every value it needs as input, performs no I/O, inspects no ambient state, and is total over its declared inputs."
] as const

const expectedEffectRules = [
  "Reusable named functions that return Effect use a named `Effect.fn` boundary; measured hot paths and anonymous protocol callbacks may use `Effect.fnUntraced`.",
  "`Effect.gen` is used for sequential control flow. Direct `map`, `flatMap`, `andThen`, and pipe-based combinators remain valid for expressions and small pipelines.",
  "Effect platform services are preferred whenever they model the capability; thin `Effect.try`, `Effect.tryPromise`, `Effect.callback`, or `Stream.callback` adapters are limited to missing services.",
  "Recoverable external failures are translated into tagged errors in the Effect error channel; impossible internal states are explicit defects.",
  "Resources have scoped release, finalizers, or interruption cleanup."
] as const

const expectedHostRules = [
  "Host adapters are exact by file, declaration, construct, and occurrence. Effect runners stay in registered entrypoints and framework bridges.",
  "Fire-and-forget work is owned and supervised so neither rejection nor Effect failure is silently discarded."
] as const

const expectedBoundaryEnforcement = {
  "I-1": [
    ".dependency-cruiser.cjs",
    "test/architecture/i1-cli-isolation.test.ts",
    "test/architecture/ipc-boundary.test.ts",
    "test/architecture/depcruise-exclude.test.ts",
    "test/architecture/server-app-split.test.ts"
  ],
  "I-2": [
    "test/architecture/backend-ownership.test.ts",
    "apps/server/test/integration/state-root-lock.test.ts"
  ],
  "I-3": [
    "apps/server/test/integration/endpoint-file.test.ts",
    "packages/client-ts/test/integration/find-or-spawn.test.ts",
    "packages/client-ts/test/integration/spawn-lock.test.ts"
  ],
  "I-4": [
    "apps/server/runtime/connection-tracker.ts",
    "apps/server/composition/app.ts",
    "apps/server/test/unit/connection-tracker.test.ts",
    "apps/server/test/integration/endpoint-file.test.ts",
    "apps/server/test/unit/harness.test.ts"
  ]
} as const

const expectedBoundaryPolicyLink = "This policy is owner-routed by `CODEOWNERS`, review-ordered by `REVIEW.md`, modeled in `docs/architecture/expand.c4`, executed for I-1 by `.dependency-cruiser.cjs`, and verified by `test/architecture/effect-policy.test.ts` plus the invariant-specific architecture tests below."

const parseBoundaryEnforcementMap = (source: string): Record<string, ReadonlyArray<string>> => {
  const section = markdownSection(source, "### Enforcement path map")
  return Object.fromEntries(section.split(/\r?\n/).flatMap((line) => {
    const match = /^\| (I-[1-4]) \| ((?:`[^`]+`(?:, )?)+) \|$/.exec(line)
    return match === null
      ? []
      : [[match[1] ?? "", [...(match[2] ?? "").matchAll(/`([^`]+)`/g)].map((path) => path[1] ?? "")]]
  }))
}

const normalizeMarkdown = (source: string): string =>
  source.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean).join(" ")

const markdownSection = (source: string, heading: string, nextHeading?: string): string => {
  const normalized = source.replace(/\r\n/g, "\n")
  const remainder = normalized.split(`${heading}\n`)[1] ?? ""
  return (nextHeading === undefined ? remainder : remainder.split(`\n${nextHeading}`)[0] ?? "").trim()
}

const markdownList = (source: string, marker: RegExp): ReadonlyArray<string> => {
  const items: Array<string> = []
  for (const line of source.replace(/\r\n/g, "\n").split("\n")) {
    const match = marker.exec(line)
    if (match !== null) {
      items.push(match[1] ?? "")
    } else if (/^\s+\S/.test(line) && items.length > 0) {
      const index = items.length - 1
      items[index] = `${items[index] ?? ""} ${line.trim()}`
    }
  }
  return items.map((item) => item.replace(/\s+/g, " ").trim())
}

const numberedItems = (source: string): ReadonlyArray<string> => markdownList(source, /^\d+\. (.*)$/)
const bulletItems = (source: string): ReadonlyArray<string> => markdownList(source, /^- (.*)$/)
const paragraphs = (source: string): ReadonlyArray<string> =>
  source.replace(/\r\n/g, "\n").split(/\n\s*\n/).map(normalizeMarkdown).filter(Boolean)

describe("Effect policy enforcement", () => {
  it.live("keeps the pre-commit hook at the exact reviewed byte string", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))

      expect(yield* fs.readFileString(path.join(root, ".githooks/pre-commit"))).toBe(expectedPreCommit)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("runs the complete CI job command sequences without the retired Effect audit", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
      const workflow = yield* parseWorkflow(
        yield* fs.readFileString(path.join(root, ".github/workflows/ci.yml"))
      )
      const runCommands = (job: typeof WorkflowJob.Type) =>
        job.steps.flatMap((step) => step.run === undefined ? [] : [step.run])
      const checksSteps = workflow.jobs.checks.steps

      expect(workflow).toEqual(expectedWorkflow)
      expect(Object.keys(workflow.jobs)).toEqual(["checks", "desktop-e2e", "binary-smoke"])
      expect({
        checks: runCommands(workflow.jobs.checks),
        "desktop-e2e": runCommands(workflow.jobs["desktop-e2e"]),
        "binary-smoke": runCommands(workflow.jobs["binary-smoke"])
      }).toEqual(expectedJobCommands)
      expect(checksSteps.flatMap((step) => step.run ?? [])).not.toContain(["npm run effect", "audit"].join(":"))
      expect(checksSteps[2]).toEqual({
        name: "Install dependencies (frozen lockfile)",
        run: "npm ci"
      })
      expect(checksSteps[3]).toEqual({
        name: "Lint",
        run: "npm run lint"
      })
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("keeps the exact ordered architecture ownership pairs", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
      const source = yield* fs.readFileString(path.join(root, "CODEOWNERS"))
      const records = source.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#"))
        .map((line) => line.split(/\s+/))

      expect(records).toEqual(expectedCodeOwners)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("keeps referenced architecture policies present and pins I-1 through I-4 to enforcement", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
      const referenceSources = yield* Effect.all([
        fs.readFileString(path.join(root, "CODEOWNERS")),
        fs.readFileString(path.join(root, "REVIEW.md")),
        fs.readFileString(path.join(root, "docs/architecture/expand.c4")),
        fs.readFileString(path.join(root, ".dependency-cruiser.cjs"))
      ])
      for (const source of referenceSources) expect(source).toContain("BOUNDARIES.md")
      const referencedPolicies = [...new Set(referenceSources.flatMap((source) =>
        [...source.matchAll(/docs\/architecture\/[A-Z_]+\.md/g)].map((match) => match[0])
      ))].sort()
      const policies = yield* Effect.all(referencedPolicies.map((policy) =>
        fs.readFileString(path.join(root, policy)).pipe(Effect.map((source) => [policy, source] as const))
      ))
      const boundaries = policies.find(([policy]) => policy === "docs/architecture/BOUNDARIES.md")?.[1] ?? ""
      const invariantHeadings = [...boundaries.matchAll(/^## (I-[1-4]\. .+)$/gm)].map((match) => match[1] ?? "")

      expect(referencedPolicies).toEqual([
        "docs/architecture/BOUNDARIES.md",
        "docs/architecture/EFFECT_ONLY.md"
      ])
      expect(invariantHeadings).toEqual([
        "I-1. Frontend isolation",
        "I-2. One AppLayer per state root",
        "I-3. One discovery file per state root",
        "I-4. Server lifetime: zero-connection shutdown"
      ])
      const enforcementMap = parseBoundaryEnforcementMap(boundaries)
      expect(enforcementMap).toEqual(expectedBoundaryEnforcement)
      const linkSection = markdownSection(boundaries, "### Enforcement path map")
      expect(paragraphs(linkSection)[0]).toBe(expectedBoundaryPolicyLink)
      const enforcementPaths = [...new Set([
        "CODEOWNERS",
        "REVIEW.md",
        "docs/architecture/expand.c4",
        "test/architecture/effect-policy.test.ts",
        ...Object.values(enforcementMap).flat()
      ])]
      for (const enforcementPath of enforcementPaths) {
        expect(yield* fs.exists(path.join(root, enforcementPath)), `missing ${enforcementPath}`).toBe(true)
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("publishes the approved invariant and cumulative completion contract", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
      const [design, policy] = yield* Effect.all([
        fs.readFileString(path.join(root, "docs/superpowers/specs/2026-07-13-effect-only-codebase-design.md")),
        fs.readFileString(path.join(root, "docs/architecture/EFFECT_ONLY.md"))
      ])
      const designDefinition = markdownSection(
        design,
        "## Definition of Effect-Only",
        "## Repository-Wide Invariants"
      )
      const designInvariants = markdownSection(
        design,
        "## Repository-Wide Invariants",
        "## Scope"
      )
      const policyBoundary = markdownSection(policy, "# Effect-only boundary", "## Pure code stays pure")
      const policyPure = markdownSection(policy, "## Pure code stays pure", "## Required Effect shapes")
      const policyEffects = markdownSection(policy, "## Required Effect shapes", "## Host adapters and runners")
      const policyHosts = markdownSection(policy, "## Host adapters and runners", "## Commands")
      const policyCommands = markdownSection(policy, "## Commands", "## Permanent ratchets")
      const policyRatchets = markdownSection(policy, "## Permanent ratchets", "## Completion")
      const policyCompletion = markdownSection(policy, "## Completion")
      const headings = [...policy.matchAll(/^#{1,6} (.+)$/gm)].map((match) => match[1] ?? "")

      expect(headings).toEqual(expectedPolicyHeadings)
      expect(normalizeMarkdown(policyBoundary).startsWith(normalizeMarkdown(designDefinition))).toBe(true)
      expect(numberedItems(designInvariants)).toHaveLength(13)
      expect(numberedItems(policyBoundary)).toEqual(numberedItems(designInvariants))
      expect(paragraphs(policyBoundary).at(-1)).toBe(
        "Official diagnostics, the local semantic rule, exact host-boundary validation, and tracked source coverage are cumulative evidence."
      )
      expect(bulletItems(policyPure)).toEqual(expectedPureRules)
      expect(bulletItems(policyEffects)).toEqual(expectedEffectRules)
      expect(bulletItems(policyHosts)).toEqual(expectedHostRules)
      expect(policyCommands).toContain("npm run lint")
      expect(policyCommands).toContain("npm run typecheck:all")
      expect(policyCommands).toContain("Pull-request reviewers inspect the diff")
      expect(policyRatchets).toContain("warnings, and suggestions")
      expect(numberedItems(policyCompletion)).toHaveLength(7)
      expect(paragraphs(policyCompletion).at(-1)).toBe(
        "A narrow test or the absence of obvious Promise syntax is not sufficient. Static checks, behavior tests, runtime certification, and human review are cumulative."
      )
    }).pipe(Effect.provide(NodeServices.layer)))
})
