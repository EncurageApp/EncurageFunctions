# Recovery from client null sentinels

## Scope and compatibility

The Functions backend and Encurage app share the optional numeric scheduling
fields `snoozeInterval`, `nextNotificationTime`, and `notificationCount` on
`events` and `prescription_events`. Clearing a field must leave it absent in
RTDB. Some iOS Firebase writes persisted `{__rnfbNull: true}` instead.

An object in `snoozeInterval` previously produced `NaN` during reminder
arithmetic. Terminal task creation then failed before recording a skipped
occurrence or advancing the schedule.

Both V1 and V2 now accept only positive finite numeric snooze intervals, keeping
legacy numeric strings compatible. Missing or malformed values use the normal
reminder intervals. V2 still anchors reminders to the stored due time and retains
the 30-second settlement delay and ten-minute skipped-push grace.

The client database adapter transports ordinary null data values as empty RTDB
nodes (`{}`) on iOS, avoiding the SDK's null encoder. RTDB treats these as absent
values. Clearing fields stays inside the original atomic write; Android values
are passed through unchanged. Server transforms/export metadata retain SDK
handling. Older clients remain supported by the backend fallback.

## Acceptance and risk matrix

| Risk | Acceptance criterion | Validation |
| --- | --- | --- |
| Existing sentinel blocks recovery | An overdue occurrence produces a finite terminal deadline | Schedule fixtures and recovery integration test |
| Valid snooze changes | Positive numeric and legacy numeric-string intervals keep the same checkpoints | Schedule/helper tests |
| Future or paused record advances early | Future records remain pending and paused records are excluded | Schedule and recovery tests |
| Retry duplicates a skipped dose or advances twice | The same terminal task resolves one occurrence once | Recovery integration test and existing occurrence tests |
| Given dose becomes skipped | Given resolution wins and retains single advancement | Recovery integration test and existing occurrence tests |
| Catch-up sends obsolete pushes | Old terminal state resolves without a late skipped push | Recovery integration test |
| New app write stores another sentinel | Atomic field clearing removes the RTDB fields; Android transport stays unchanged | Client write-boundary tests and isolated demo emulator; actual device flows remain a release check |
| Mixed client/backend versions | Existing field shapes and V1/V2 routing stay compatible | Shared timing helper, routing tests, client contract tests |

## Release order

No deployment, rollout change, production repair, or app release is part of the
local implementation. Each needs Victor's explicit authorization.

1. Deploy the backend fix first. Update the V2 terminal consumer
   (`settleNotificationV2Terminal`) and isolated terminal retry worker
   (`retryNotificationV2TerminalCron`) before, or together with, the four live
   V2 workers and two recovery workers. Old consumers recompute terminal timing,
   so updating only the workers that enqueue tasks is insufficient. Include the
   V1 reminder workers (`checkNextNotificationTimeCron` and
   `processPrescriptionNextNotificationCron`) to preserve the kill-switch path.
2. Let the existing five-minute recovery workers process already-overdue
   records. Successful terminal transactions clear their scheduling fields with
   Admin SDK nulls. Recovery can require multiple passes when several occurrences
   were missed. Do not bulk-mark historical doses or move schedule timestamps
   forward by hand.
3. Verify terminal deadlines are finite, skipped records use deterministic
   occurrence keys, next occurrences advance, and obsolete pushes stay suppressed.
   Confirm `Invalid time value` errors stop for the affected records. Observe
   retry/dead-letter queues and normal upcoming delivery as well.
4. Release the verified client fix to prevent new malformed writes. Test actual
   iOS and Android dose-given, schedule-edit, and snooze flows before release.

No data migration or rollout flag change is required for records reached by
normal recovery. The existing indexed recovery scan is still bounded to its
latest 500 stale records; this change does not resolve possible starvation of
records outside that window. Investigate any unrecovered records separately.
V1 receives the snooze-arithmetic safeguard, but its initial discovery still
uses truthiness for `nextNotificationTime` and has no equivalent historical
recovery. Do not expect switching these legacy records to V1 to repair null
sentinels in their notification timestamp fields.

## Rollback

The backend fix is compatible with old and new client data. Retain it if a client
release is rolled back. Reverting the backend can restore the failure for older
clients or unprocessed sentinel-bearing records. Do not roll back by deleting
resolved doses, changing ownership flags, or bypassing transactional safeguards.
