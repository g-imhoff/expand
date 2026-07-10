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
      errors: [{ messageId: "outOfOrder", line: 2 }]
    },
    {
      filename: "private-before-export.ts",
      code: "const helper = 1\nexport const value = helper",
      errors: [{ messageId: "outOfOrder", line: 2 }]
    },
    {
      filename: "import-after-export.ts",
      code: 'export const value = 1\nimport type { Effect } from "effect"',
      errors: [{ messageId: "outOfOrder", line: 2 }]
    },
    {
      filename: "default-class-after-export.ts",
      code: "export type Name = string\nexport default class Service {}",
      errors: [{ messageId: "outOfOrder", line: 2 }]
    }
  ]
})
