import { RuleTester } from "eslint"
import tseslint from "typescript-eslint"
import { describe, it } from "vitest"
import { moduleOrder } from "../../eslint-rules/module-order.mjs"

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } }
  },
  plugins: { local: { rules: { example: { create: () => ({}) } } } }
})

ruleTester.run("module-order groups", moduleOrder, {
  valid: [
    {
      filename: "ordered.ts",
      code: [
        'import type { Effect } from "effect"',
        "export interface Api { readonly run: Effect.Effect<void> }",
        "export class Service {}",
        "export type Name = string",
        "export const value = 1",
        "type Internal = string",
        "const helper = 1",
        "export {}"
      ].join("\n")
    },
    "/** Public API. */\nexport interface Api {}\n\nexport const value = 1",
    "/* File banner. */\n\nexport interface Api {}\n\nexport const value = 1",
    "// Public types\nexport interface Api {}\n\nexport const value = 1",
    "export interface Api {}\n\nexport const value = 1 // value",
    "/** Public API. */ export interface Api {}\n\nexport const value = 1",
    "export interface Api {\n  /** Member docs. */\n  member: string\n}\n\nexport const value = 1",
    "  export interface Api {}\n\n  export const value = 1",
    "\"use client\"\nexport interface Api {}\n\nexport const value = 1",
    "#!/usr/bin/env node\nexport interface Api {}\n\nexport const value = 1",
    "export as namespace Expand\n\ndeclare const internal: unique symbol"
  ],
  invalid: [
    {
      filename: "interface-after-value.ts",
      code: "export const value = 1\nexport interface Api {}",
      output: "export interface Api {}\n\nexport const value = 1",
      errors: [{ messageId: "outOfOrder", line: 2 }]
    },
    {
      filename: "private-before-export.ts",
      code: "const helper = 1\nexport const value = helper",
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 2 }]
    },
    {
      filename: "import-after-export.ts",
      code: 'export const value = 1\nimport type { Effect } from "effect"',
      output: 'import type { Effect } from "effect"\n\nexport const value = 1',
      errors: [{ messageId: "outOfOrder", line: 2 }]
    },
    {
      filename: "default-class-after-export.ts",
      code: "export type Name = string\nexport default class Service {}",
      output: "export default class Service {}\n\nexport type Name = string",
      errors: [{ messageId: "outOfOrder", line: 2 }]
    },
    {
      filename: "export-assignment-after-private.ts",
      code: "declare const plugin: {}\nexport = plugin",
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 2 }]
    },
    {
      filename: "namespace-export-after-private.ts",
      code: "declare const internal: unique symbol\nexport as namespace Expand",
      output: "export as namespace Expand\n\ndeclare const internal: unique symbol",
      errors: [{ messageId: "outOfOrder", line: 2 }]
    }
  ]
})

ruleTester.run("module-order autofix safety", moduleOrder, {
  valid: [],
  invalid: [
    {
      filename: "move-erased-interface.ts",
      code: "export const value = 1\nexport interface Api {}",
      output: "export interface Api {}\n\nexport const value = 1",
      errors: [{ messageId: "outOfOrder", line: 2 }]
    },
    {
      filename: "move-private-type.ts",
      code: "type Internal = string\nexport const value = 1",
      output: "export const value = 1\n\ntype Internal = string",
      errors: [{ messageId: "outOfOrder", line: 2 }]
    },
    {
      filename: "move-import.ts",
      code: 'export const value = 1\nimport type { Effect } from "effect"',
      output: 'import type { Effect } from "effect"\n\nexport const value = 1',
      errors: [{ messageId: "outOfOrder", line: 2 }]
    },
    {
      filename: "asi-boundary.ts",
      code: "export const value = source\nexport interface Api {}\n[entry].forEach(use)",
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 2 }]
    },
    {
      filename: "stable-group-dependency.ts",
      code: 'export { value }\nexport const value = 1\nimport type { X } from "x"',
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 3 }]
    },
    {
      filename: "leading-comment.ts",
      code: "/** docs for value */\nexport const value = 1\nexport interface Api {}",
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 3 }]
    },
    {
      filename: "separated-leading-comment.ts",
      code: "/** docs for value */\n\nexport const value = 1\nexport interface Api {}",
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 4 }]
    },
    {
      filename: "separated-file-tsdoc.ts",
      code: "/** @fileoverview Public API. */\n\nexport const value = 1\nexport interface Api {}",
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 4 }]
    },
    {
      filename: "trailing-comment.ts",
      code: "export const value = 1\nexport interface Api {}\n// footer",
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 2 }]
    },
    {
      filename: "external-import-equals-runtime-order.ts",
      code: 'export const before = record("before")\nimport second = require("second")',
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 2 }]
    },
    {
      filename: "internal-import-equals-runtime-order.ts",
      code: 'export const before = record("before")\nimport alias = Namespace.value',
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 2 }]
    },
    {
      filename: "private-runtime-dependency.ts",
      code: "const dependency = make()\nexport const value = consume(dependency)",
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 2 }]
    },
    {
      filename: "side-effect-order.ts",
      code: 'const first = record("first")\nexport const second = record("second")',
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 2 }]
    },
    {
      filename: "module-request-order.ts",
      code: 'export { value } from "first"\nimport "second"',
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 2 }]
    },
    {
      filename: "import-equals-request-order.ts",
      code: 'export { value } from "first"\nimport second = require("second")',
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 2 }]
    },
    {
      filename: "decorated-class.ts",
      code: "const decorator = makeDecorator()\n@decorator\nexport class Service {}",
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 3 }]
    },
    {
      filename: "computed-class-key.ts",
      code: "const key = makeKey()\nexport class Service { static [key] = 1 }",
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 2 }]
    },
    {
      filename: "static-initialization.ts",
      code: "const dependency = make()\nexport class Service { static value = dependency }",
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 2 }]
    }
  ]
})

ruleTester.run("module-order comment-safe fixes", moduleOrder, {
  valid: [],
  invalid: [
    {
      filename: "tsdoc.ts",
      code: "export const value = 1\n\n/** Public API. */\nexport interface Api {}",
      output: "/** Public API. */\nexport interface Api {}\n\nexport const value = 1",
      errors: [{ messageId: "outOfOrder", line: 4 }]
    },
    {
      filename: "banner.ts",
      code: "/* File banner. */\n\nexport const value = 1\nexport interface Api {}",
      output: "/* File banner. */\n\nexport interface Api {}\n\nexport const value = 1",
      errors: [{ messageId: "outOfOrder", line: 4 }]
    },
    {
      filename: "first-block-comment.ts",
      code: "/* docs for value */\nexport const value = 1\nexport interface Api {}",
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 3 }]
    },
    {
      filename: "section.ts",
      code: "export const value = 1\n\n// Public types\nexport interface Api {}",
      output: "// Public types\nexport interface Api {}\n\nexport const value = 1",
      errors: [{ messageId: "outOfOrder", line: 4 }]
    },
    {
      filename: "detached-comment.ts",
      code: "export const value = 1\n// belongs to value\n\nexport interface Api {}",
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 4 }]
    },
    {
      filename: "same-line-tsdoc.ts",
      code: "export const value = 1; /** Public API. */\nexport interface Api {}",
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 2 }]
    },
    {
      filename: "same-line-block.ts",
      code: "export const value = 1; /* Public API. */\nexport interface Api {}",
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 2 }]
    },
    {
      filename: "same-line-leading-tsdoc.ts",
      code: "export const value = 1\n/** Public API. */ export interface Api {}",
      output: "/** Public API. */ export interface Api {}\n\nexport const value = 1",
      errors: [{ messageId: "outOfOrder", line: 2 }]
    },
    {
      filename: "trailing.ts",
      code: "export const value = 1 // value\nexport interface Api {}",
      output: "export interface Api {}\n\nexport const value = 1 // value",
      errors: [{ messageId: "outOfOrder", line: 2 }]
    },
    {
      filename: "member-tsdoc.ts",
      code:
        "export const value = 1\nexport interface Api {\n  /** Member docs. */\n  member: string\n}",
      output:
        "export interface Api {\n  /** Member docs. */\n  member: string\n}\n\nexport const value = 1",
      errors: [{ messageId: "outOfOrder", line: 2 }]
    },
    {
      filename: "indented.ts",
      code: "  export const value = 1\n  export interface Api {}",
      output: "  export interface Api {}\n\n  export const value = 1",
      errors: [{ messageId: "outOfOrder", line: 2 }]
    },
    {
      filename: "same-line-suffix.ts",
      code: "export const value = 1\nexport interface Api {} const helper = 1",
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 2 }]
    },
    {
      filename: "same-line-comment-suffix.ts",
      code: "export const value = 1 // value\nexport interface Api {} const helper = 1",
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 2 }]
    },
    {
      filename: "same-line-prefix.ts",
      code:
        'import type { X } from "x"; export const value = 1\nexport interface Api {}',
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 2 }]
    },
    {
      filename: "eslint-directive.ts",
      code: "export const value = 1\n// eslint-disable-next-line local/example\nexport interface Api {}",
      linterOptions: { reportUnusedDisableDirectives: false },
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 3 }]
    },
    {
      filename: "eslint-config-directive.ts",
      code: "/* global ExternalApi */\nexport const value = 1\nexport interface Api {}",
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 3 }]
    },
    {
      filename: "adjacent-ts-directive.ts",
      code:
        'import type { X } from "x" // @ts-ignore\nexport const value = 1\nexport interface Api {}',
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 3 }]
    },
    {
      filename: "uppercase-ts-directive.ts",
      code: "export const value = 1\n\n// @TS-NOCHECK\nexport interface Api {}",
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 4 }]
    },
    {
      filename: "ts-jsx-pragma.ts",
      code: "export const value = 1\n/** @jsxImportSource react */\nexport interface Api {}",
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 3 }]
    },
    {
      filename: "triple-slash-directive.ts",
      code:
        'export const value = 1\n/// <reference types="node" />\nexport interface Api {}',
      output: null,
      errors: [{ messageId: "unsafeOrder", line: 3 }]
    },
    {
      filename: "prologue.ts",
      code: "\"use client\"\nexport const value = 1\nexport interface Api {}",
      output: "\"use client\"\nexport interface Api {}\n\nexport const value = 1",
      errors: [{ messageId: "outOfOrder", line: 3 }]
    },
    {
      filename: "hashbang.ts",
      code: "#!/usr/bin/env node\nexport const value = 1\nexport interface Api {}",
      output: "#!/usr/bin/env node\nexport interface Api {}\n\nexport const value = 1",
      errors: [{ messageId: "outOfOrder", line: 3 }]
    }
  ]
})
