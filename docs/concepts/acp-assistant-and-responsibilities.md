# ACP assistant and responsibilities

## Concept snapshot

Expand is a general ACP client with a personal assistant and installable background responsibilities. The MVP includes a built-in catalog, event reactions, and cron jobs. A public marketplace and user APIs remain future goals.

Expand connects to any ACP-compatible backend, including OpenCode v2. The personal assistant works across projects and gives users a messaging-style interface for requests, updates, and help.

## How it works

Creators use Expand's APIs to declare the integrations, setup inputs, reactions, and scheduled behaviors a package requires or offers. A package such as GitHub Automation offers ready-to-use behaviors that users can enable individually.

Users connect their accounts, complete creator-defined setup steps, and choose which behaviors to enable. The assistant can explain failures and help debug problems. Setup does not depend on asking an AI to work out straightforward configuration steps.

Webhooks launch reactions as soon as a relevant event is detected. Cron launches scheduled work, and users can create custom scheduled jobs. The backend continues receiving events and running tasks when the desktop client is closed.

A conflict-fix responsibility starts a dedicated conversation, repairs the conflict, and validates the result. Failed validation starts another repair attempt. Once validation passes, the responsibility commits and pushes automatically. The user can stop the session.

When the client opens, unread activity shows which responsibilities ran and their outcomes. Users can open each run's conversation and inspect its changes. Failed or interrupted attempts are distinguishable from completed, pushed fixes.

## Evidence and differentiation

ACP provides a common conversation protocol with negotiated capabilities. Compatibility depends on the capabilities a backend offers; a general client cannot assume every backend supports the same optional operations. [ACP initialization](https://agentclientprotocol.com/protocol/v1/initialization)

Hermes demonstrates configurable automation blueprints. Home Assistant demonstrates reusable templates with independent configured instances. These support the package concept, while Expand's interaction and lifecycle rules follow the decisions below. [Hermes automation blueprints](https://hermes-agent.nousresearch.com/docs/reference/automation-blueprints-catalog), [Home Assistant blueprints](https://www.home-assistant.io/docs/blueprint/)

Expand combines a personal assistant, creator-defined integration setup, individually enabled event reactions and schedules, and a general ACP client. Memory and responsibilities persist across changes of ACP backend.

## Key decisions and boundaries

- **User-decided.** Support any ACP-compatible backend, including OpenCode v2. Remove the Jev-centered approach and the assumption that Expand is specifically an OpenCode client. General backend compatibility is the goal.
- **User-decided.** Configure separate personal-assistant and background-task model/provider defaults in Settings. Project coding conversations retain their own controls. Ordinary assistant messages should work without requiring users to choose a model or reasoning settings each time.
- **User-decided.** Creators declare required Expand integrations and setup inputs through Expand's APIs. Use creator-defined setup instead of depending on AI for routine configuration, because that dependency can disrupt the user experience. The assistant remains available for debugging.
- **User-decided.** Build an Expand-owned memory engine for the MVP. Reusing an external memory engine was considered; the user chose the in-house option for now.
- **User-decided.** The personal assistant and background responsibilities can access personal memory, including automatically launched PR-fix sessions. Coding conversations started in the project area cannot access personal memory. Access follows the origin of the conversation.
- **User-decided.** Prefer webhooks for immediate reactions. Keep cron for work that belongs on a schedule and support custom scheduled jobs. Conflict reactions should begin when detected instead of waiting for a scheduled check.
- **User-decided.** Keep the backend running independently of the desktop client. Closing the client does not stop responsibilities.
- **User-decided.** Enabled conflict-fix responsibilities commit and push automatically after validation. Failed validation starts another repair attempt instead of ending the task with unpushed changes.
- **User-decided.** Background tasks have no automatic time or spending limit. They continue repairing until validation passes, subject to the user's ability to stop the session.
- **User-decided.** Turning off a responsibility prevents future launches. Existing sessions continue and have a separate Stop action.
- **User-decided.** Show available package updates in the UI and apply them only when the user chooses to update. Installed packages retain their current version until then.
- **User-decided.** Start with a built-in catalog. Defer public third-party publishing while keeping future marketplace and user API access as goals.
- **Agent-inferred and provisional.** Use "Discover" for the catalog and "Responsibilities" for enabled behaviors. These names remain provisional.

## Stress-test result

Pausing a responsibility during a run established separate controls for future launches and active sessions. Turning off a responsibility does not cancel work already underway.

Package updates require explicit user action, avoiding silent changes to installed behavior.

Failed validation feeds continued repair. A task must not claim completion or push an unvalidated fix. The user rejected automatic time and spending cutoffs, accepting potentially open-ended repair attempts.

Preserving intended code behavior is a requirement of conflict fixing. Validation cannot prove that every fix preserves intent. Conversation history, visible changes, and outcome notifications provide the agreed way to inspect a problematic run. Automatic pushing remains an accepted behavior after validation.

## Deferred uncertainties and success signals

Technical design still needs to settle ACP interoperability, memory persistence and retrieval, validation enforcement, and recovery from interrupted execution. These questions do not change the accepted product boundaries.

Success means installing a responsibility without AI-dependent setup, running it with the client closed, retaining memory across backend changes, and inspecting every completed or interrupted run.
