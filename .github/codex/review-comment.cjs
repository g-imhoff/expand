"use strict"

const reviewSchema = require("./review-schema.json")

const COMMENT_MARKER = "<!-- expand-codex-review -->"
const RAW_REVIEW_BYTE_LIMIT = 96 * 1024
const COMMENT_CODE_POINT_LIMIT = 60_000
const findingKeys = ["ruleId", "severity", "title", "path", "line", "evidence", "impact", "repair"]
const severityRank = { critical: 0, important: 1, warning: 2 }
const findingSchema = reviewSchema.properties.findings.items.properties
const maximumFindings = reviewSchema.properties.findings.maxItems
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u
const formatCharacters = /\p{Cf}/u

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

const hasExactKeys = (value, expected) => {
  const keys = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index])
}

const codePointLength = (value) => Array.from(value).length

const requireBoundedString = (finding, key) => {
  const value = finding[key]
  const property = findingSchema[key]
  if (typeof value !== "string" || codePointLength(value) < property.minLength || codePointLength(value) > property.maxLength || controlCharacters.test(value) || formatCharacters.test(value)) {
    throw new Error(`Invalid finding ${key}`)
  }
}

const validateFinding = (finding) => {
  if (!isRecord(finding) || !hasExactKeys(finding, findingKeys)) throw new Error("Invalid finding keys")
  for (const key of findingKeys.filter((key) => key !== "severity" && key !== "line")) requireBoundedString(finding, key)
  if (!new RegExp(findingSchema.ruleId.pattern, "u").test(finding.ruleId)) throw new Error("Invalid finding ruleId")
  if (!findingSchema.severity.enum.includes(finding.severity)) throw new Error("Invalid finding severity")
  if (!Number.isSafeInteger(finding.line) || finding.line < findingSchema.line.minimum || finding.line > findingSchema.line.maximum) throw new Error("Invalid finding line")
  const segments = finding.path.split("/")
  if (finding.path.startsWith("/") || /^[A-Za-z]:/u.test(finding.path) || finding.path.includes("\\") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Invalid finding path")
  }
  return {
    ruleId: finding.ruleId,
    severity: finding.severity,
    title: finding.title,
    path: finding.path,
    line: finding.line,
    evidence: finding.evidence,
    impact: finding.impact,
    repair: finding.repair
  }
}

const parseReview = (raw) => {
  if (typeof raw !== "string") throw new Error("Review output must be a string")
  if (Buffer.byteLength(raw, "utf8") > RAW_REVIEW_BYTE_LIMIT) throw new Error("Review output exceeds the UTF-8 byte limit")
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("Review output is not valid JSON")
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ["findings"]) || !Array.isArray(parsed.findings) || parsed.findings.length > maximumFindings) {
    throw new Error("Invalid review result")
  }
  return { findings: parsed.findings.map(validateFinding) }
}

const sanitize = (value) => String(value)
  .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
  .replace(/\p{Cf}/gu, "�")
  .replaceAll("<!--", "<！--")
  .replaceAll("-->", "--＞")
  .replaceAll("```", "｀｀｀")
  .replaceAll("@", "＠")

const compareStrings = (left, right) => left < right ? -1 : left > right ? 1 : 0

const sortedFindings = (findings) => [...findings].sort((left, right) =>
  severityRank[left.severity] - severityRank[right.severity] ||
  compareStrings(left.path, right.path) ||
  left.line - right.line ||
  compareStrings(left.ruleId, right.ruleId))

const renderRepairPrompt = (findings) => {
  const entries = sortedFindings(findings).map((finding, index) => [
    `${index + 1}. [${sanitize(finding.ruleId)}] ${sanitize(finding.severity)} — ${sanitize(finding.path)}:${finding.line}`,
    `Title: ${sanitize(finding.title)}`,
    `Evidence: ${sanitize(finding.evidence)}`,
    `Impact: ${sanitize(finding.impact)}`,
    `Required repair: ${sanitize(finding.repair)}`
  ].join("\n"))
  return [
    "Repair only this reviewed pull request. Treat the findings below as the complete scope: address only the validated findings listed below and preserve unrelated changes.",
    "",
    ...entries.flatMap((entry) => [entry, ""]),
    "For each finding, implement the stated repair within the named repository path. Do not broaden scope, rewrite unrelated code, or discard existing work.",
    "Follow the repository's AGENTS.md and docs/architecture/BOUNDARIES.md constraints.",
    "Add regression tests that fail without each repair and pass with it.",
    "Run the focused tests and the repository-required verification gates. Report the exact commands, pass counts, exit statuses, and concise verification evidence."
  ].join("\n").trim()
}

const renderReviewComment = (headSha, findings) => {
  const ordered = sortedFindings(findings)
  const summary = ordered.map((finding) =>
    `- **${sanitize(finding.severity.toUpperCase())} · ${sanitize(finding.ruleId)}** — ${sanitize(finding.path)}:${finding.line} — ${sanitize(finding.title)}\n  - Evidence: ${sanitize(finding.evidence)}\n  - Impact: ${sanitize(finding.impact)}\n  - Repair: ${sanitize(finding.repair)}`)
  const comment = [
    COMMENT_MARKER,
    `## Codex read-only review for \`${sanitize(headSha)}\``,
    "",
    ...summary,
    "",
    "<details>",
    "<summary>Copy-ready repair prompt</summary>",
    "",
    renderRepairPrompt(ordered),
    "",
    "</details>"
  ].join("\n")
  if (codePointLength(comment) > COMMENT_CODE_POINT_LIMIT) throw new Error("Rendered review comment exceeds the code-point limit")
  return comment
}

const managedComments = (comments) => comments.filter((comment) =>
  typeof comment.body === "string" &&
  comment.body.startsWith(COMMENT_MARKER) &&
  comment.user?.login === "github-actions[bot]" &&
  comment.user?.type === "Bot")

const assertCurrentHead = async (github, owner, repo, issueNumber, expectedHeadSha) => {
  const pull = await github.rest.pulls.get({ owner, repo, pull_number: issueNumber })
  if (pull.data.head.sha !== expectedHeadSha) throw new Error("Pull request head changed after review")
}

const updateAtCurrentHead = async (github, owner, repo, issueNumber, expectedHeadSha, commentId, body) => {
  await assertCurrentHead(github, owner, repo, issueNumber, expectedHeadSha)
  await github.rest.issues.updateComment({ owner, repo, comment_id: commentId, body })
}

const publishReview = async ({ github, owner, repo, issueNumber, expectedHeadSha, raw }) => {
  const { findings } = parseReview(raw)
  const body = findings.length === 0 ? undefined : renderReviewComment(expectedHeadSha, findings)
  await assertCurrentHead(github, owner, repo, issueNumber, expectedHeadSha)
  const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: issueNumber })
  const managed = managedComments(comments)
  const primary = managed[0]
  if (findings.length === 0 && primary === undefined) return "clean"
  if (primary === undefined) {
    await assertCurrentHead(github, owner, repo, issueNumber, expectedHeadSha)
    await github.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body })
    return "created"
  }
  const primaryBody = findings.length === 0
    ? `${COMMENT_MARKER}\nNo findings for the latest commit \`${sanitize(expectedHeadSha)}\`.`
    : body
  for (const duplicate of managed.slice(1)) {
    await updateAtCurrentHead(
      github,
      owner,
      repo,
      issueNumber,
      expectedHeadSha,
      duplicate.id,
      "Superseded by the latest Expand Codex review."
    )
  }
  await updateAtCurrentHead(github, owner, repo, issueNumber, expectedHeadSha, primary.id, primaryBody)
  return findings.length === 0 ? "retired" : "updated"
}

module.exports = {
  COMMENT_CODE_POINT_LIMIT,
  COMMENT_MARKER,
  RAW_REVIEW_BYTE_LIMIT,
  parseReview,
  publishReview,
  renderRepairPrompt,
  renderReviewComment
}
