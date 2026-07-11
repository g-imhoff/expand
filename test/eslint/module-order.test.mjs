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
  }
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
    }
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
