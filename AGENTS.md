# Encurage Functions Engineering Guide

## Repository scope

- TypeScript source: `src/`
- Generated output: `lib/`
- Tests: `test/`
- Notification V2 runbook: `src/notificationsV2/README.md`
- Firebase CLI configuration currently lives in the parent directory.
- `src/` is authoritative. Do not manually edit `lib/`.

## Cross-Repository Coordination

The Encurage product spans these repositories:

- **Encurage** — React Native application.
- **functions (encurage-functions)** — Firebase backend, privileged data access,
  callable functions, triggers, scheduled jobs, notifications, subscriptions,
  rules, indexes, and backend infrastructure.

Cross-repository coordination is required for changes involving:

- Firebase callable request or response contracts.
- Realtime Database paths, schemas, fields, indexes, and security assumptions.
- Authentication, ownership, caregiver access, and authorization.
- Medication calculations, schedules, time zones, reminders, and dose records.
- Push-notification payloads, routing, badges, and deep links.
- Subscription products, receipt validation, entitlements, and pricing.
- Privacy, consumer-health-data handling, and retention.
- Shared enums, identifiers, error codes, and validation rules.

Use this coordination process:

1. Identify every affected repository during intake.
2. Inspect the producer and every consumer of a changed contract.
3. Clearly report affected repositories without modifying another repository
   implicitly.
4. Define repository-specific acceptance criteria and validation.
5. Preserve backward compatibility unless Victor explicitly approves a public
   contract change.
6. Specify implementation and release sequencing.
7. Consider migrations, feature flags, mixed-version clients, and rollback.
8. Verify complete behavior across repository boundaries.
9. Identify checks that could not be performed in the final handoff.
10. Do not deploy, publish, release, or change production Firebase data without
    Victor's explicit approval.

Ownership boundaries:

- **Encurage** owns client presentation, local state, navigation, device
  behavior, deep-link consumption, and consumption of backend contracts.
- **functions** owns server-side authorization, privileged data access, callable
  behavior, database administration, scheduling, notification generation,
  subscription validation, and backend infrastructure.

Manage every change affecting more than one repository as one cross-repository
engineering task, even when implementation occurs in separate workspaces or
pull requests.

## Safety

- Preserve all existing working-tree changes.
- Do not deploy, publish, push, commit, invoke production Functions, read or
  write production RTDB data, or change rollout configuration without explicit
  authorization.
- Never print, commit, copy into documentation, or package `.env` values,
  service-account JSON, receipts, purchase tokens, FCM tokens, or health data.
- Use emulators only with an isolated demo project and fixture data.

## Architecture

- Primary RTDB: `encurage-new-default-rtdb`.
- Legacy migration source: `oncure-app`.
- `events` stores as-needed episode state.
- `prescription` stores prescription definitions.
- `prescription_events` stores scheduling and reminder state.
- `prescription_doses` stores resolved occurrences.
- `children/{childId}` resolves the owner using `parentId`, with `parent_id`
  retained only for legacy compatibility.
- `caregiver` grants child-scoped care-family access.
- `users/{uid}` contains notification, locale, timezone, and entitlement state.

## Security invariants

- Every callable must authenticate the caller.
- Every child-, event-, prescription-, journal-, tracking-, folder-, or
  caregiver-scoped operation must authorize owner or explicitly assigned
  caregiver access using server-read data.
- Never accept a caller-supplied UID as proof of identity.
- Never accept arbitrary database collection/path names; use server allowlists.
- Validate payload shape and limits before Admin SDK access.
- Remember that Admin SDK operations bypass RTDB security rules.
- New callable work must consider App Check and abuse/rate limits.

## Scheduling and notifications

- Treat medication timing, DST behavior, dose resolution, and notification
  delivery as high-risk.
- Preserve mutually exclusive V1/V2 ownership through the shared routing module.
- Preserve leases, deterministic occurrence/checkpoint keys, per-recipient
  delivery-attempt keys, fresh reads and transactional state guards, bounded
  retries, and dead-letter recovery; do not weaken their safeguards against
  duplicate delivery or advancing an occurrence twice under retries or
  overlapping workers.
