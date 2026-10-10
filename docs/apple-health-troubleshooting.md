# Apple Health (HealthKit) troubleshooting playbook

For whoever handles a user report that Apple Health data is missing, wrong or duplicated. Lily follows the same
steps in chat (see the APPLE HEALTH TROUBLESHOOTING rule in `src/lib/agent/prompt.ts`); this is the developer view.

## Where to look (Firestore, project health-tracker-new-bf407)
| What | Path | Tells you |
|---|---|---|
| Last import | `users/{uid}/meta/healthSync` | `lastSyncAt`, counts of workouts/sleep nights/step days. Missing = never imported |
| Native build | `users/{uid}/meta/client`, `appBuilds/ios-<ver>-<build>` | which build the user opens (reported on every launch) |
| Imported workouts | `users/{uid}/workouts` where `source == "appleHealth"` | `hkType`, `category`, `device`, `externalId` (HealthKit UUID) |
| Sleep / resting HR | `users/{uid}/sleep/{date}`, `users/{uid}/vitals/{date}` | per night / per day |
| Rejected nutrient values | `nutrientRejections` | (nutrition, not HealthKit) |
| User complaints | `users/{uid}/agentFeedback` | what Lily flagged via `flag_mistake` |

## Symptom → cause → fix
1. **Nothing ever imported** (`healthSync` missing): permission never granted or app not connected. iOS shows the permission sheet only once and hides read denials from apps. Fix: iPhone Settings → Health → Data Access & Devices → Lily → enable Workouts, Steps, Weight, Sleep, Heart Rate; then Profile → Apple Health → Sync now.
2. **Error "Missing com.apple.developer.healthkit entitlement"** on Connect: the build lacks the HealthKit capability (Xcode → Signing & Capabilities → + HealthKit) or it is a simulator/unsigned build. Needs a new build from the account owner.
3. **Connect button missing**: not the iOS app (web/WhatsApp), or an old build without the plugin (`appBuilds` shows the version).
4. **Imported earlier but new workouts missing**: the watch has not synced to the phone yet, or the source app doesn't write to Health. The app re-reads the last 3 days on every open and does a full 60-day pass weekly.
5. **Duplicate workout**: a typed/chat workout with a different type or a duration differing by more than max(10 min, 35%) is kept as a separate session (rule: `isSameSession` in `src/lib/health/workoutMap.ts`). Delete the manual one.
6. **Wrong type** (e.g. padel shows as Tennis/Other): Apple has no padel type. Racket sports map to `other` until Lily learns it per user (she asks once and stores a fact).
7. **Steps differ from the Health app**: Health is authoritative; the import overwrites `steps/{date}` with Apple's de-duplicated daily sum, so a manual entry for a day with Health data is replaced on the next sync.
8. **Profile values changed on their own**: the weekly full import auto-fills weight, height, workout types, activity level and average steps (`meta/healthSync.autoFilledAt`).
9. **Sleep looks off**: a night is keyed to the day it ENDS; segments ending after 18:00 count toward the next day.

## Before escalating
Check `agentFeedback` for the user's note, compare `lastSyncAt` with the complaint time, and confirm the build in `meta/client`. Never ask the user for Apple credentials or Health exports.
