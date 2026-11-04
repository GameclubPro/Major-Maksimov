# Current Documentation

Start with the root and scoped `AGENTS.md`, then select the reference for the affected boundary.
Check commands, paths and defaults against the current checkout's `package.json`, Compose and
scripts. A configuration default or an earlier release report does not establish the live state.

| Task                                                 | Maintained reference                                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Development, check selection, ownership and release  | [Development and release workflow](development-reliability-plan.md)                                                                         |
| Agent context, impact planning and focused checks    | [Machine interface](development/agent-machine-contract.md)                                                                                  |
| Existing feature tests and browser server setup      | [Feature regression map](development/feature-regressions.md)                                                                                |
| Local dependencies and disposable PostgreSQL/Redis   | [Local environment](development/agent-local-environment.md)                                                                                 |
| Accumulated CI scope and verified registry delivery  | [CI image delivery](development/ci-image-delivery.md)                                                                                       |
| Intended behavior, defects and conflicting evidence  | [Behavior evidence](development/behavior-evidence.md)                                                                                       |
| API domains and compatibility boundaries             | [API reference](development/api-domain-reference.md)                                                                                        |
| Product UI decisions and settings navigation         | [Active decisions](development/miniapp-product-decisions.md) and [settings contract](miniapp-settings-overview-design.md)                   |
| Production operations and incident response          | [Runbook](runbook.md), [operations reference](development/production-operations-reference.md) and [incident playbook](incident-playbook.md) |
| Production host and shared resources                 | [REG.RU profile](operations/runbooks/reg-production-profile.md)                                                                             |
| Safety Desk bots, queues and shared observations     | [Runtime overview](operations/runbooks/safety-desk-runtime-overview.md)                                                                     |
| Publisher rights, preparation and access diagnostics | [Current access runbook](operations/runbooks/publisher-access-refresh-rollout.md)                                                           |
| Refactoring an existing boundary                     | [Preserved contracts](refactor-safe-boundaries.md) and [candidate roadmap](operations/plans/2026-11-01-safe-refactoring-roadmap.md)         |
| Workspace and runtime overview                       | [Project description](project-description.md)                                                                                               |

Independent Lastik work starts with [its scoped instructions](../apps/eraser/AGENTS.md).
Advertising buttons and Birzhik profiles use the [marketplace contract](development/marketplace-integration.md);
chat shops use the [Karavan runbook](operations/runbooks/karavan-chat-marketplaces.md).
Sanctions and activity use the [current regression map](development/feature-regressions.md#sanctions-and-participant-activity).

## Plans And Historical Evidence

Dated plans, audits and [incident reports](operations/incidents/) describe their own source revision
and observation window. They do not establish today's deployment, authorize recovery or publication,
or instruct an agent to resume an old task. An open acceptance item stays unproved until fresh
evidence closes it; its age does not turn it into success or a prerequisite for unrelated work.
Use the current task and the matching runbook to select work. Preserve explicit product decisions
and persisted-state safety boundaries through the [evidence procedure](development/behavior-evidence.md).

Superseded design proposals, duplicate execution plans and retired cloud notes have been removed
from the working tree. Their contents remain in Git history; consult a historical revision only
when it helps explain a specific decision. Current instructions and maintained references take
precedence over obsolete commands, release snapshots and implementation checklists.

Retire a completed plan when its durable requirements, current code/test links and
remaining acceptance boundaries have a maintained home. Remove or replace inbound links
in the same change and let `check:docs` verify them. A date, unused-looking filename or
lack of imports alone is not evidence that a migration, fixture, asset, recovery reader
or operational tool is unnecessary. Preserve those consumers and safety contracts;
Git history holds superseded execution chronology without keeping competing instructions.
