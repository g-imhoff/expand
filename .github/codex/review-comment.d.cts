export type FindingSeverity = "critical" | "important" | "warning"

export interface Finding {
  readonly ruleId: string
  readonly severity: FindingSeverity
  readonly title: string
  readonly path: string
  readonly line: number
  readonly evidence: string
  readonly impact: string
  readonly repair: string
}

export interface Review {
  readonly findings: ReadonlyArray<Finding>
}

export interface GitHubClient {
  readonly paginate: (method: unknown, parameters: Record<string, unknown>) => Promise<ReadonlyArray<{
    readonly id: number
    readonly body?: string
    readonly user?: { readonly login: string, readonly type: string } | null
  }>>
  readonly rest: {
    readonly pulls: {
      readonly get: (parameters: Record<string, unknown>) => Promise<{ readonly data: { readonly head: { readonly sha: string } } }>
    }
    readonly issues: {
      readonly createComment: (parameters: Record<string, unknown>) => Promise<unknown>
      readonly updateComment: (parameters: Record<string, unknown>) => Promise<unknown>
      readonly listComments: unknown
    }
  }
}

export const COMMENT_MARKER: "<!-- expand-codex-review -->"
export const COMMENT_CODE_POINT_LIMIT: number
export const RAW_REVIEW_BYTE_LIMIT: number
export function parseReview(raw: string): Review
export function renderRepairPrompt(findings: ReadonlyArray<Finding>): string
export function renderReviewComment(headSha: string, findings: ReadonlyArray<Finding>): string
export function publishReview(input: {
  readonly github: GitHubClient
  readonly owner: string
  readonly repo: string
  readonly issueNumber: number
  readonly expectedHeadSha: string
  readonly raw: string
}): Promise<"created" | "updated" | "retired" | "clean">
