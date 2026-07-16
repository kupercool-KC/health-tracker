# Data model

All data is namespaced per user under `users/{uid}`.

```
users/{uid}                       → { healthTokenHash? }  (server-only; never client-readable)
users/{uid}/meta/profile          → UserProfile   (client read/write — own uid only)
users/{uid}/meta/memory           → Memory        (client read/write — own uid only)
users/{uid}/meta/alerts           → Alerts        (client read/write — own uid only)
users/{uid}/meals/{date}          → MealDay        (date = yyyy-mm-dd; client read, server write)
users/{uid}/workouts/{externalId} → Workout   (doc id = externalId, for dedupe; client read, server write)
healthTokens/{sha256(token)}      → { uid, createdAt }  (server-only; never client-readable)
```

## MealEntry (element of MealDay.entries)
| field       | type                | notes                                  |
|-------------|---------------------|-----------------------------------------|
| id          | string              | generated server-side (crypto.randomUUID) |
| time        | ISO-8601 string     | when the food was consumed/logged      |
| name        | string              | human summary of what was logged       |
| calories    | number (kcal)       | estimated                              |
| protein     | number (g)          | estimated                              |
| carbs/fat/fiber | number (g)?     | optional, estimated                    |
| mealType    | enum?               | breakfast/lunch/dinner/snack            |
| source      | "text" \| "photo"   | how it was logged                      |
| confidence  | number 0..1?        | model confidence, if provided          |
| confirmedAt | ISO-8601 string     | when the row was written               |

## MealDay
| field   | type                          | notes                                    |
|---------|-------------------------------|--------------------------------------------|
| date    | string (yyyy-mm-dd)           | also the doc id                            |
| entries | MealEntry[]                   | one doc per day holds all that day's meals |
| totals  | {calories, protein, carbs, fat} | recomputed server-side on every append   |

`/api/nutrition` upserts into this doc inside a Firestore transaction (read
existing entries, append, recompute totals, write back) rather than creating
a new doc per entry — the client just needs one doc read per day to get
today's totals, no range query needed.

## Workout
| field            | type            | notes                                        |
|------------------|-----------------|-----------------------------------------------|
| id / externalId  | string          | dedupe key (also the doc id) |
| userId           | string          | owner uid, resolved server-side from the Health Sync token |
| type             | string          | HKWorkoutActivityType name           |
| date             | string (yyyy-mm-dd) | derived from startTime               |
| startTime/endTime| ISO-8601 string |                                      |
| duration         | number (sec)    |                                      |
| distance         | number? (m)     |                                      |
| pace             | number? (sec/km)|                                      |
| heartRate        | {avg?, max?}    |                                      |
| calories         | number?         |                                      |
| elevationGain    | number? (m)     |                                      |
| source           | "appleHealth" \| "manual" |                            |
| syncedAt         | ISO-8601 string |                                      |

`/api/health` currently accepts a simplified flat shape matching this table.
Health Auto Export's real export format nests quantities as `{qty, units}`
inside a `{data: {workouts: [...]}}` envelope with non-standard date strings
— adapting the route to parse that directly is separate follow-up work.

## UserProfile (users/{uid}/meta/profile)
Matches the spec's onboarding + goals fields: `name, email, age, gender,
height, weight, goal, activityLevel, workoutTypes, dietaryPrefs, avoidFoods,
allergies, preferredFoods, calorieGoal, proteinGoal, showCarbs, showFat,
showFiber, language, units, onboarded, createdAt, updatedAt`. Also where the
EN/HE language toggle persists (`src/lib/i18n/useI18n.tsx` reads/writes
`language` here).

## Memory / Alerts (users/{uid}/meta/memory, .../alerts)
Placeholders for now — schemas defined in `src/lib/types.ts`, not yet
read/written anywhere (Profile screen's Memory and Alerts sections are a
later phase).

## Health Sync token
| field     | type            | notes                                            |
|-----------|-----------------|---------------------------------------------------|
| uid       | string          | owning user                                       |
| createdAt | ISO-8601 string |                                                    |

Doc id is `sha256(plaintext token)`. The plaintext token is shown to the user
exactly once (on generation, from `/profile`); only its hash is ever stored.
`users/{uid}.healthTokenHash` tracks the current hash so generating a new
token can delete the old `healthTokens/{hash}` doc, revoking it.

## Write paths
- **Nutrition**: browser → `POST /api/nutrition` (Firebase ID token) → OpenAI parse → Admin SDK transaction upserting `meals/{date}`.
- **Workouts**: `POST /api/health` (personal Health Sync token, resolved to a uid server-side) → Admin SDK upsert.
- **Health Sync token**: browser (signed in) → `POST/DELETE /api/settings/health-token` (Firebase ID token) → Admin SDK mint/revoke.
- **Profile/memory/alerts**: browser (signed in) → direct Firestore client writes to `users/{uid}/meta/*` (allowed by `firestore.rules` for the owning uid — the only client-writable paths in this project).

Everything else stays Admin-SDK-only: the browser reads its own
`users/{uid}/{meals,workouts}/**` and `users/{uid}/meta/**`, but never the
`users/{uid}` doc itself or `healthTokens/**`.
