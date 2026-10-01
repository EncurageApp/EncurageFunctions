FIREBASE COST REDUCTION RUNBOOK

Realtime Database downloads, notification recovery, and analytics reads

| Field | Value |
| --- | --- |
| Project | encurage-new / encurage-new-default-rtdb |
| Owner | Functions engineering |
| Current status | V2 recovery schedule changed locally and deployed to every 5 minutes |
| Monitoring gate | Allow 48 hours of post-deployment observation before the next production change |
| Primary metric | Realtime Database Downloads (bytes read) |

> **Current finding** The observed cost spike is download-driven: the Firebase usage view showed 125.56 GB for the billing period and an approximately 27.94 GB daily peak, while storage and connections remained comparatively low.

## 1. Objective and guardrails

Reduce Realtime Database download volume without changing notification behavior unexpectedly. This runbook is intended to be executed in stages, with production changes separated from diagnosis and measurement.

- Do not deploy another change until the 48-hour monitoring window is complete, unless notification reliability or cost severity requires an explicit emergency decision.

- Do not delete production data as part of this work. Any retention or cleanup change requires a separate approved migration plan and backup verification.

- Preserve V1/V2 ownership, leases, deterministic delivery keys, retry behavior, and mixed-version mobile compatibility.

- Coordinate backend changes with the Encurage mobile repository when a query shape, path, field, or response contract changes.

## 2. What changed and why it matters

At 100% rollout, all valid parents route to V2. The recovery path then uses indexed due-time scans instead of the small static-canary scan. Each recovery worker can read up to 500 initial records and 500 reminder records per invocation, even when no candidate ultimately needs processing.

```text
src/notificationsV2/routing.ts: notificationV2RolloutPercent = 100 => all parents route to V2
```

```text
src/notificationsV2/functions.ts:376-389 => .endAt(before).limitToLast(BATCH_SIZE).once("value")
```

```text
src/notificationsV2/functions.ts:440-443 => two scans per collection: initial and reminder
```

There are two recovery functions, one for events and one for prescription_events. Before the schedule reduction, both ran every minute. They now run every five minutes; the four live V2 workers remain every minute.

## 3. Phase 0 - 48-hour monitoring

This phase is already in progress. Do not edit code or rollout settings during the window unless explicitly approved.

| Check | How to evaluate | Pass signal |
| --- | --- | --- |
| Realtime Database Downloads | Firebase Console > Realtime Database > Usage; compare daily bytes with the pre-change peak | A sustained step-down after data lag clears |
| Recovery cadence | Logs for reconcileEventNotificationsV2Cron and reconcilePrescriptionNotificationsV2Cron | Runs approximately five minutes apart |
| Recovery scan counts | Inspect initialScannedCount and reminderScannedCount | Lower aggregate reads; no growing backlog |
| Notification reliability | Check late, skipped, duplicate, and missing notification reports | No material increase in failures or lateness |
| Retry queues | Review notification_v2_jobs and notification_v2_terminal_jobs metrics/logs | No persistent queue growth or retry storm |

> **Interpretation** Firebase billing graphs can lag. Judge the change using several hours of post-deployment data plus logs, not the first individual data point.

## 4. Phase 1 - Fix recovery discovery

After the monitoring gate, replace repeated broad scans with a bounded, oldest-first stale window. The goal is to prevent each invocation from rereading the same newest 500 records and to ensure older records cannot be starved by newer ones.

### Implementation

- Define a recovery window, for example records older than the five-minute live boundary but no older than a bounded lookback period.

- Query with startAt(recoveryStart), endAt(before), and limitToFirst(batchSize).

- Paginate with a stable cursor containing the due timestamp and event ID, or persist a checkpoint if the backlog can exceed one invocation.

- Process the oldest records first and record scan count, candidate count, oldest scanned due time, newest scanned due time, and backlog estimate.

- Retain fresh reads, leases, deterministic attempt keys, and the existing V1/V2 routing check.

- Add a bounded maximum amount of recovery work per invocation so recovery cannot consume the entire function timeout.

### Acceptance criteria

- A quiet database does not reread a large fixed batch indefinitely.

- A synthetic stale backlog is drained oldest-first over successive runs.

- A record just outside the live five-minute window is recovered within the documented tolerance.

- Overlapping recovery invocations do not send duplicates.

- Recovery logs make scan volume and backlog health visible.

## 5. Phase 2 - Review retry worker cadence

The retry workers also poll every minute. Do not change them automatically; first measure queue depth and the latency requirements for failed push delivery.

- If queues are normally empty, move retryNotificationV2Cron and retryNotificationV2TerminalCron to five or fifteen minutes.

- Keep exponential backoff and maximum-attempt limits unchanged.

- Validate that terminal skipped notifications remain inside their delivery grace period.

- Alert on persistent queue growth before reducing retry frequency further.

## 6. Phase 3 - Reduce analytics downloads

Several insight callables currently read all records under a child and filter the requested dates in application code. This is a high-value read optimization because the requested report range is already bounded by the API.

| Function | Current behavior | Target behavior |
| --- | --- | --- |
| Growth insights | Reads /tracking/{childId} by category, then filters dateTime | Query data/dateTime range, then filter category |
| Vital insights | Reads /tracking/{childId} by category, then filters dateTime | Query data/dateTime range, then filter category |
| Symptom insights | Reads /tracking/{childId} by trackingType, then filters dateTime | Query data/dateTime range, then filter trackingType |
| Journal insights | Reads /journal/{childId}, then filters dateTime | Query data/dateTime range directly |
| Medication insights | Reads all doses for a prescription event | Keep if bounded; otherwise add event/date index path |

### Recommended query

```text
const snapshot = await db.ref(`/tracking/${childId}`)
  .orderByChild("data/dateTime")
  .startAt(request.startAt)
  .endAt(request.endAt)
  .once("value");
```

- Add .indexOn for data/dateTime under the relevant tracking and journal child paths in the authoritative database rules repository.

- Run a read-only audit first to count records missing data/dateTime; do not assume they exist.

- If missing timestamps are found, measure the count and decide whether to support a legacy fallback or perform a separately approved migration.

- Preserve the callable response shape so the mobile app does not need a contract change.

Affected backend files include growthInsights.ts, vitalInsights.ts, symptomInsights.ts, journalInsights.ts, and potentially medicationInsights.ts. The Encurage mobile repository is a consumer and should be regression-tested, but does not need modification if the response contract stays unchanged.

## 7. Phase 4 - Reduce repeated caregiver reads

Notification processing queries the caregiver collection by parent and then loads caregiver user records. This is functionally correct but broad and repeated for each due event.

- Measure caregiver query bytes and frequency before redesigning the path.

- Consider a child-scoped membership index such as caregiver_by_child/{childId}/{caregiverUid}.

- Keep the authoritative caregiver record and update the derived index atomically or through a reliable repair job.

- Validate owner/caregiver authorization and child membership against server-read data; never trust a caller-supplied UID.

## 8. Index and data-model checklist

Indexes reduce query work, but they do not make a large result set free. A query returning 500 records still downloads those records.

| Path / field | Purpose | Verification |
| --- | --- | --- |
| events.nextScheduledDose | Live initial-dose discovery | Confirm .indexOn and bounded result window |
| events.nextNotificationTime | Live reminder discovery | Confirm .indexOn and bounded result window |
| prescription_events.nextScheduledDose | Prescription initial discovery | Confirm .indexOn |
| prescription_events.nextNotificationTime | Prescription reminder discovery | Confirm .indexOn |
| tracking/{childId}.data/dateTime | Date-bounded insights | Add index in rules repository |
| journal/{childId}.data/dateTime | Date-bounded journal insights | Add index in rules repository |
| prescription_doses.prescriptionEventId | Medication dose lookup | Confirm .indexOn and response size |
| caregiver.parent_id | Caregiver lookup | Confirm .indexOn; prefer child-scoped index later |

## 9. Verification and rollout sequence

1. Capture a baseline: Realtime Database Downloads, recovery scan counts, retry queue depth, and representative analytics response sizes.

1. Implement and test recovery discovery in the functions repository using emulator fixtures, including stale backlog, pagination, overlap, and duplicate-delivery cases.

1. Implement analytics date-bounded queries and rules indexes; audit timestamp completeness first.

1. Build and run the full functions test suite. Add tests for query bounds and legacy timestamp handling.

1. Deploy one change group at a time, starting with recovery discovery, then analytics reads, then caregiver index redesign.

1. After each deployment, observe database downloads, notification correctness, function errors, and retry queues before proceeding.

1. If downloads do not fall after backend changes, inspect the Encurage mobile repository for broad realtime listeners and repeated reconnects.

## 10. Rollback plan

- Keep the previous function revision available for rollback.

- If notification lateness or missed delivery increases, restore the prior recovery implementation or cadence while preserving the V1 shutdown decision separately.

- If analytics results change, revert the query implementation while retaining any non-breaking indexes.

- Do not use a database data deletion as a rollback mechanism.

## 11. Evidence and current limitations

- Observed Firebase usage: Downloads 125.56 GB for the current billing period, approximately 27.94 GB daily peak, Storage 327.32 MB current, Connections 26 / 200K.

- Deployed project contains V1 and V2 notification function families; V2 rollout at 100% activates the broad indexed recovery path.

- The five-minute recovery schedule has been deployed, but enough post-deployment data must accumulate before its effect can be judged.

- Exact post-change log comparison still requires authenticated Cloud Logging/CLI access.

- No production data was modified by this runbook creation.

## 12. Notification V2 internal bookkeeping paths

These server-side paths prevent duplicate notifications, coordinate concurrent workers, and recover failed terminal processing.

### notification_v2_delivery_attempts

One record per notification checkpoint and recipient:

```text
notification_v2_delivery_attempts/{attemptId}
```

The ID is a SHA-256 hash of the checkpoint key and recipient UID. Records contain `attemptId`, `checkpointKey`, `userId`, `eventId`, `dueAt`, `attemptCount`, `attemptedAt`, `status`, and completion details such as `messageId` and `completedAt`. Statuses include `attempting`, `accepted`, `disabled`, `no_token`, `stale_token`, and `transient_error`.

These records prevent duplicate sends. They currently appear to have no cleanup or expiration process, so audit their growth first. They mainly affect storage, but broad reads would also create download cost.

### notification_v2_runtime

One record per event and event type:

```text
notification_v2_runtime/{kind}/{eventId}
```

`kind` is `as_needed` or `prescription`. While processing, the record stores a lease with `owner`, `until`, and `claimedAt`. After processing, it stores `lastCheckpointKey`, `lastCheckpointDueAt`, `lastDeliveryDecision`, `supersededStages`, and `updatedAt`.

Leases prevent overlapping workers from processing the same event. Leases are removed after processing, but the event-level runtime record remains.

### notification_v2_terminal_jobs

An isolated retry queue for unexpected terminal notification failures:

```text
notification_v2_terminal_jobs/{jobId}
```

Records contain task identity (`kind`, `eventId`, `childId`, `occurrenceAt`, `dueAt`), timing fields (`enqueuedAt`, `scheduledFor`, `nextAttemptAt`), status, attempt count, error, and lease fields. Lifecycle:

```text
pending -> processing -> removed after success
                    -> pending after failure
                    -> dead_letter after 5 failures
```

Successful jobs are removed; `dead_letter` records remain for investigation. The retry worker polls this path every minute and reads up to 100 due jobs.

### Bookkeeping cleanup recommendations

- Add retention/cleanup for old `notification_v2_delivery_attempts` records.
- Remove old `notification_v2_runtime` records after an event is completed and outside its retry window.
- Keep `notification_v2_terminal_jobs` small and alert on `dead_letter`.
- Consider moving retry queues to Cloud Tasks if RTDB polling remains expensive.
- Keep all three paths server-only in the Realtime Database rules.

These paths are more likely to affect storage than the major download spike, which was primarily caused by broad recovery scans.
