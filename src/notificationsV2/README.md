# Notification V2 Rollout

This implementation is live-only when explicitly enabled. The default route is
still the configured UID allowlist. Percentage and all-user routing are available
only when the rollout mode environment values are changed and redeployed.

## Runtime configuration

Set these environment values for the functions deployment:

```text
NOTIFICATION_V2_CANARY_ENABLED=true
NOTIFICATION_V2_CANARY_UIDS=l2R5cSW1CKfq8CsU002WsQqb3ui1,9xwWrl1ugPht3bRQTGvLlUHJOog2,tJbkGPwW79bruRe8QQgLHzvrdk73,l26xtne9JTSHpywaD12rs1DB8fZ2,rjeHGFSZBFY6zqaQ95E3rBQHZTh1,zvi7h7AsSqSfacqp7tB89IwHny72
NOTIFICATION_V2_KILL_SWITCH=false
NOTIFICATION_V2_ROLLOUT_MODE=canary
NOTIFICATION_V2_ROLLOUT_PERCENT=0
```

`NOTIFICATION_V2_CANARY_ENABLED` defaults to disabled. The UID environment
value is optional because the same six UIDs are the source-code defaults.
`NOTIFICATION_V2_KILL_SWITCH=true` disables V2 ownership even when the canary
or rollout mode is enabled.

Rollout modes:

1. `canary`: only explicit canary UIDs use V2.
2. `percentage`: explicit canary UIDs plus a deterministic percentage of
   non-canary parent IDs use V2.
3. `all`: all parent IDs use V2.

Percentage routing hashes `parentId` into 10,000 stable buckets, so the same
parent remains on the same side of the V1/V2 boundary until the configured
percentage changes.

## Deployment order

1. Deploy all V2 functions while the canary is disabled.
2. Deploy the four V1 functions with their canary exclusion guards.
3. Set `NOTIFICATION_V2_CANARY_ENABLED=true` at a time when no canary dose is due.
4. Deploy the four V1 functions first. This creates a short, recoverable gap.
5. Immediately deploy all V2 functions. Their catch-up processing handles the gap.

Do not deploy V2 live before the V1 guards; that can duplicate notifications.

The canary supports the currently released app database writes. Phase 4 adds
backend reconciliation for the app-versus-terminal race without requiring a
mobile release.

## Phase 1 work discovery

The canary workers discover live work from the indexed event timestamps before
looking at older canary records:

1. Query the worker's `nextScheduledDose` or `nextNotificationTime` field for
   the inclusive five-minute live window.
2. Paginate the complete window in database order; a 500-record page is not a
   per-invocation limit.
3. Resolve each candidate's child and owner, then enforce the shared V2 routing
   decision before processing it.
4. Process live routed candidates before stale routed candidates.
5. In `canary` mode, stale recovery uses the previous owner-to-child-to-event
   scan for the explicit canary owners. In `percentage` or `all` mode, stale
   recovery queries the indexed due-time fields directly and applies the same
   routing decision.

Notification timing, messages, snooze behavior, leases, and event state
transitions are unchanged by Phase 1.

## Phase 2 parent routing metadata

Both event collections use `parentId` as denormalized routing metadata.
`children/{childId}.parentId` (with `parent_id` as a legacy fallback) remains
authoritative.

During the canary:

1. Live discovery can reject an event with a known V1-owned `parentId`
   before reading its child.
2. Missing event `parentId` values retain the child lookup fallback.
3. Events that reach canary processing verify the stored value against the
   child and repair mismatches before routing.
4. `populateEventParentIdV2` and `populatePrescriptionEventParentIdV2` add
   `parentId` to newly created V2-owned events, including events created by old
   app versions.
5. V1-owned events are not modified by the Phase 2 triggers.

V1, current mobile releases, notification timing, and caregiver routing ignore
this additive field. Before cohort expansion, all active events in the cohort
must be backfilled and audited for missing children, missing parents, and
parent mismatches.

## Phase 3 live and recovery isolation

The four delivery workers query and process only the inclusive five-minute live
window. They no longer enumerate older canary events.

Two separate five-minute recovery workers own timestamps older than the live
boundary:

- `reconcileEventNotificationsV2Cron`
- `reconcilePrescriptionNotificationsV2Cron`

In canary mode, each recovery invocation loads a canary child's collection once
and classifies the active events as initial or reminder work. In percentage and
all-user modes, recovery queries indexed due fields directly and applies the
same parent routing decision used by live workers. Existing leases,
deterministic delivery attempts, and fresh event reads protect the small
boundary overlap between independent invocations.

## Cost monitoring follow-up

The recovery workers run every five minutes. The four live V2 workers remain on
the one-minute schedule, and retry workers retain their existing cadence.

After the 48-hour rollout monitoring window:

1. Compare Realtime Database Downloads before and after the V1 shutdown and the
   V2 rollout change.
2. Check recovery logs for `initialScannedCount`, `reminderScannedCount`, and
   candidate counts. High scan counts with zero candidates indicate that
   recovery is still reading too broadly.
3. Replace the recovery `limitToLast(500)` scans with a bounded, paginated
   oldest-first stale window so older records cannot be starved by newer ones.
4. Review whether the retry workers also need a five-minute schedule, based on
   queue depth and acceptable retry latency.
5. Audit analytics callables for whole-child history reads and add date-bounded
   storage/query paths where usage justifies it.

Recovery preserves the schedule resolver's existing behavior: it sends only the
latest applicable non-terminal checkpoint while the occurrence remains open,
sends a terminal skipped notification only inside the ten-minute terminal
grace, and advances older terminal state without an obsolete push.

## Phase 4 given-versus-terminal resolution

The scheduled occurrence remains immutable while it is being resolved:

- Prescription: `prescription_doses.date`
- As-needed: the pre-update pending dose's `timeAvailable`, falling back to the
  pre-update event `nextScheduledDose`

`reconcilePrescriptionDoseGivenV2` handles a prescription dose becoming
`given: true`. It advances only when `nextScheduledDose` still equals that
occurrence. If terminal processing already advanced the event as skipped, it
changes the matching resolution to given without advancing again and removes
the deterministic skipped duplicate.

`reconcileAsNeededDoseGivenV2` detects a pending `dosageGiven` entry becoming
given. If terminal processing paused the event concurrently, it restores
`state: active`, preserves the app-calculated next dose, and records the
matching occurrence as given.

Stage 4 is dispatched through `settleNotificationV2Terminal` at least 30
seconds after the snooze-adjusted terminal due time. The task re-reads the
event and exits when the occurrence, stage-4 due time, owner, or resolution has
changed. It finalizes skipped state before delivery and rechecks given state
before sending. Existing checkpoint and recipient attempt keys make task
retries idempotent.

Terminal reliability behavior:

1. The primary terminal queue records `enqueuedAt`, `scheduledFor`, `startedAt`,
   `latenessMs`, and `dueLatenessMs` in structured logs. Processing more than
   one minute after `scheduledFor` emits `V2 terminal settlement late` at
   warning severity.
2. The skipped-push grace is ten minutes from the terminal due time. The
   30-second given-wins settlement delay remains unchanged.
3. When the final occurrence reaches the prescription end date, terminal
   processing materializes the skipped dose, clears notification and snooze
   state, changes the prescription event to `completed`, sends the skipped
   notification inside the grace period, and returns success. It does not retry
   the expected absence of another dose.
4. Unexpected primary-task failures are written to
   `notification_v2_terminal_jobs` and acknowledged on the primary queue.
   `retryNotificationV2TerminalCron` owns those retries independently, with a
   lease, exponential backoff, five attempts, and a final `dead_letter` state.
   This prevents an unexpected terminal failure from repeatedly returning 500
   and throttling normal skipped notifications.

### Terminal latency monitoring

The deployed code emits a structured warning whenever terminal processing
starts more than one minute late. Create a Cloud Monitoring log-based alert
using this filter:

```text
resource.type="cloud_run_revision"
jsonPayload.message="V2 terminal settlement late"
jsonPayload.latenessMs>60000
```

A notification channel is where Google sends the alert; it is not part of push
notification processing. Supported destinations include email, SMS, Slack,
PagerDuty, and the Google Cloud mobile app. Without a channel, the warning is
still recorded in Cloud Logging, but nobody is proactively notified.

Start with an email notification channel and alert on any matching warning
during the canary. At broader rollout, retain the immediate alert and add a
sustained-rate policy so both one late terminal task and a queue-level incident
remain visible. Also create alerts for `V2 isolated terminal retry failed` and
jobs reaching `dead_letter`.

Monitoring status as of July 11, 2026: structured lateness logging is deployed.
The Cloud Monitoring alert policy and notification channel are not yet created;
this does not affect terminal processing or mobile push delivery.

Phase 4 deployment order is mandatory:

1. Deploy `settleNotificationV2Terminal` so Firebase creates its Cloud Tasks
   queue.
2. Grant the cron runtime service account Cloud Tasks enqueue and task-function
   invocation permissions.
3. Deploy both given-reconciliation database triggers.
4. Deploy the four live and two recovery workers that enqueue terminal tasks.
5. Verify task enqueue, 30-second dispatch, given-wins, skipped delivery, and
   retry logs with the UID canary before any cohort expansion.

Do not deploy the enqueueing worker revisions before steps 1 and 2.

Terminal reliability production status as of July 11, 2026:

1. The `notification_v2_terminal_jobs/.indexOn` rule was added.
2. `retryNotificationV2TerminalCron`, `settleNotificationV2Terminal`,
   `reconcilePrescriptionDoseGivenV2`, and the six V2 live/recovery workers were
   deployed successfully.
3. The primary terminal queue is running with two maximum attempts, five-second
   backoff, and a 30-second maximum retry duration. Processing failures that are
   successfully recorded in the isolated retry ledger return HTTP 2xx and do
   not consume the second primary attempt.
4. `retryNotificationV2TerminalCron` completed its first production invocation
   with HTTP 200.
5. The remaining operational step is creating the Cloud Monitoring alert and
   selecting its notification channel.

## Phase 5 rollout controls

V1 guards and V2 workers use `isNotificationV2Owner(parentId)` from the shared
routing module. This keeps ownership mutually exclusive:

- If routing returns V2, V1 skips the event and V2 may process it.
- If routing returns V1, V2 rejects the event and V1 keeps processing it.
- `NOTIFICATION_V2_KILL_SWITCH=true` makes routing return V1 for every parent.

Recommended production expansion:

1. Keep `NOTIFICATION_V2_ROLLOUT_MODE=canary` until Phase 4 behavior is clean.
2. Deploy Phase 5 code without changing rollout env values.
3. Move to `NOTIFICATION_V2_ROLLOUT_MODE=percentage` with
   `NOTIFICATION_V2_ROLLOUT_PERCENT=5`.
4. Hold 24 hours, then move to `10`, `25`, `50`, and `100` as metrics stay
   clean.
5. Use `NOTIFICATION_V2_KILL_SWITCH=true` for emergency rollback, then deploy
   V1 first and V2 second if code rollback is needed.

## Required before replacing V1

Do not expand V2 beyond the UID canary until Phase 4 has been verified in
production and Phase 5 routing controls have been deployed without changing
the current `canary` rollout mode. This is a mandatory changeover gate, not an
optional follow-up.

## Follow-up checklist

Notification rollout:

1. Monitor canary logs after the Phase 5 deploy. Confirm V1 logs
   `V1 skipping V2-owned event` and V2 logs `V2 accepted routed event` for the
   same routed parents.
2. Start percentage rollout by setting:

   ```text
   NOTIFICATION_V2_ROLLOUT_MODE=percentage
   NOTIFICATION_V2_ROLLOUT_PERCENT=5
   ```

3. Deploy with `NOTIFICATION_V2_KILL_SWITCH=false`.
4. Hold for 24 hours and watch skipped-dose correctness, accepted push
   attempts, stale-token cleanup, retry jobs, terminal settlement tasks, and
   duplicate notification reports.
5. Increase to `10`, `25`, `50`, and `100` only after the previous cohort is
   clean.
6. If rollout needs to stop immediately, set:

   ```text
   NOTIFICATION_V2_KILL_SWITCH=true
   ```

   Then deploy. This routes all parents back to V1 ownership.

Operational cleanup:

1. Runtime: move from Node.js 20 to Node.js 22 before the October 30, 2026
   decommission date. Do not move directly to Node.js 24 while first-generation
   functions still exist.
2. Dependencies: upgrade `firebase-functions` in a separate pass and retest all
   callable, scheduled, database-trigger, and task-queue functions.
3. Legacy runtime config: deploy currently warns about `functions.config()`.
   Source and compiled output no longer contain `functions.config()` calls, but
   Firebase still has legacy runtime config stored under Google Play
   credentials. Confirm no deployed purchase/subscription function still reads
   the legacy config, then remove the stale runtime config with:

   ```sh
   firebase functions:config:unset googleplay
   ```

   After removal, redeploy and confirm the deploy warning is gone.
4. Database rules: when doing the broader rules cleanup, add the V2 server-only
   nodes below and add `"occurrenceKey"` to `prescription_doses/.indexOn`.

Known design follow-ups:

1. Overlapping prescription dose windows need occurrence-level notification
   state. A real canary example was `Test med` for child `Test`, with daily
   reminder times at 4:50 PM and 5:30 PM. Each dose uses the one-hour reminder
   sequence of initial, +10 minutes, +20 minutes, +45 minutes, and +60 minutes
   skipped. Because the 5:30 PM occurrence starts before the 4:50 PM
   occurrence reaches terminal, the current `prescription_events` state can
   only represent one open chain at a time.

   Current V2 stores only one `nextScheduledDose`, one `nextNotificationTime`,
   and one `notificationCount` on the event. While that reminder state exists,
   the initial prescription worker intentionally skips the event. In the canary
   case, FCM accepted the 4:50, 5:00, 5:10, and 5:35 pushes for the 4:50
   occurrence. The 5:30 occurrence could not start independently, so catch-up
   later processed it from the latest applicable stage instead of sending the
   missing 5:30 and 5:40 notifications. The final skipped notification was also
   processed outside the terminal send grace, so the dose was marked skipped
   without sending an obsolete skipped push.

   This is not a stale-token or FCM delivery problem. It is a state-model
   limitation caused by serializing multiple scheduled occurrences through one
   event-level reminder chain. V1 did not truly support overlapping reminder
   chains either; it calculated the next prescription dose from the current
   time, so an already-past same-day reminder could be skipped over instead of
   represented as an independent open occurrence.

   Recommended fix: move prescription reminder state from event-level fields to
   occurrence-level records, for example
   `notification_v2_occurrences/prescription/{eventId}_{occurrenceAt}`. Each
   occurrence should own its own `occurrenceAt`, `nextNotificationTime`,
   `notificationCount`, status, lease/runtime metadata, delivery attempts, and
   terminal settlement task. The event can still keep `nextScheduledDose` as the
   next future occurrence pointer for app compatibility, but delivery workers
   should process due occurrence records so overlapping 4:50 and 5:30 chains can
   run independently and idempotently.

2. The former `No next dose: next occurrence would be after end date` terminal
   retry storm is handled by treating the final occurrence as a successful
   completion. This fixes queue throttling from that error but does not address
   the separate overlapping-occurrence state model described above.

## V2 database rules fragment

The following nodes are server-only. These denies work only after removing the
root authenticated read/write grants because RTDB parent grants cascade.

```json
"notification_v2_runtime": {
  ".read": false,
  ".write": false,
  "$eventType": {
    ".indexOn": ["lastCheckpointDueAt", "updatedAt"]
  }
},
"notification_v2_jobs": {
  ".read": false,
  ".write": false,
  ".indexOn": ["nextAttemptAt", "status", "eventId"]
},
"notification_v2_delivery_attempts": {
  ".read": false,
  ".write": false,
  ".indexOn": ["dueAt", "status", "userId", "eventId"]
},
"notification_v2_terminal_jobs": {
  ".read": false,
  ".write": false,
  ".indexOn": ["nextAttemptAt", "status", "eventId"]
}
```

Also add `"occurrenceKey"` to the existing `prescription_doses/.indexOn`
array when the broader rules change is deployed.

## Rollback

1. Set `NOTIFICATION_V2_CANARY_ENABLED=false`.
2. Deploy the V1 functions first so they resume canary processing.
3. Disable or deploy the V2 functions with the same setting.

V2 retains the existing event scheduling fields, so V1 can resume from the
stored `nextScheduledDose`, `nextNotificationTime`, and `notificationCount`.
