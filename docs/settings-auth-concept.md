# Concept Brief: Global Connection Settings

## Concept snapshot

A global generic settings page, opened from a gear icon pinned to the bottom of the far-left icon rail, owns everything connection-related in the Expand desktop app: secrets, backend switching, and per-integration connection tests. It is decoupled from automation and any other feature. Automation is the first consumer. Feature pages keep feature config (such as the repo picker) and link out to settings when a credential is missing.

## How it works

GitHub auth runs as OAuth inside settings, once. The app holds the token centrally and every device shares it, so setup happens a single time. Settings shows connection health plus scope checks, and offers to push the same token into the local `gh` so terminal AI and the app share one identity. The feature-page repo picker stays disabled until settings reports a healthy connection; hovering the disabled picker explains the state and offers the jump into the settings OAuth flow, returning afterward with the picker enabled. Zen keys stay pasted (no OAuth exists); Gmail OAuth follows the GitHub pattern later. Secrets are write-only everywhere: entry plus save plus status, never echoed.

## Evidence and differentiation

Rail-bottom gear is the dominant pattern (VS Code, Discord, Obsidian); Docker and Slack are the outliers. Raycast is the closest analog to our seam: extensions declare required preferences that block use until set, plus a deep-link button into settings. Centralizing secrets reduces sprawl but has stranded users before (Docker keychain breakage) and leaked keys into UI and logs elsewhere (Dify, OpenClaw, Octopus records), supporting write-only storage with per-check diagnostics. Electron `safeStorage` beats keytar for new code; Jenkins and Actions prove the credential-reference pattern at scale. Our existing credential-reference shape already matches.

## Key decisions and boundaries

- User-decided: global generic page, decoupled from automation, reusable by future features. Rejected: automation-scoped settings section.
- User-decided: settings owns everything connection (secrets, backend switch, test-connection); feature pages keep feature config. Rejected: split ownership with test-connection on feature pages.
- User-decided: repo picker disabled until connected, hover explains, click jumps to settings OAuth. Rejected: pasted-token field next to the picker.
- User-decided: app-held shared token across devices over reusing the local `gh` session. Rejected alternatives: pasted tokens (setup per device, weakest), `gh` session reuse (fails on split identities across environments). Accepted trade-off: one revocation cuts all devices; scopes stay minimal.
- Agent-inferred: OAuth over pasted tokens for GitHub; Zen stays pasted. Accepted constraint: no redirect-handoff failure modes by construction for held tokens.
- Non-goals: per-feature credential stores; pasted GitHub tokens anywhere.

## Stress-test result

Strongest objections: OAuth redirect handoff stranding users (seen in GitHub Desktop, Docker Desktop) answered by app-held token with no per-device redirect; scope drift failing at night answered by scope checks naming the missing scope; shared-token blast radius accepted with minimal scopes; missing-credential dead ends answered by the picker-as-link with return target and draft preservation. Accepted risks: single revocation hits every device; token sync mechanism undecided.

## Deferred uncertainties and success signals

Token cross-device sync mechanism needs technical design. Backend-switch placement stays deferred. Success signals: connect-once setup on a fresh device with no terminal steps; zero pasted GitHub tokens in any UI; picker-to-settings-to-picker round trip preserving form state.
