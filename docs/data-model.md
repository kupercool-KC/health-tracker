# Data model

All data is namespaced per user under `users/{uid}`.

```
users/{uid}                  → { healthTokenHash? }  (server-only; never client-readable)
users/{uid}/nutrition/{entryId}   → NutritionEntry
users/{uid}/workouts/{externalId} → Workout   (doc id = externalId, for dedupe)
healthTokens/{sha256(token)}      → { uid, createdAt }  (server-only; never client-readable)
```

## NutritionEntry
| field       | type              | notes                                  |
|-------------|-------------------|----------------------------------------|
| id          | string            | Firestore doc id                       |
| userId      | string            | owner uid                              |
| description | string            | human summary of what was logged       |
| calories    | number (kcal)     | estimated                              |
| protein     | number (g)        | estimated                              |
| source      | "chat" \| "image" | how it was logged                      |
| confidence  | number 0..1?      | model confidence, if provided          |
| loggedAt    | ISO-8601 string   | when the food was consumed             |
| createdAt   | ISO-8601 string   | when the row was written               |

## Workout
| field            | type            | notes                                        |
|------------------|-----------------|-----------------------------------------------|
| id / externalId  | string          | synthetic dedupe key (also the doc id) — Shortcuts has no stable HKWorkout UUID action, so this is `activityType + "-" + startedAt` |
| userId           | string          | owner uid, resolved server-side from the Health Sync token |
| activityType     | string          | HKWorkoutActivityType name           |
| startedAt/endedAt| ISO-8601 string |                                      |
| durationSec      | number          |                                      |
| activeEnergyKcal | number?         |                                      |
| distanceMeters   | number?         |                                      |
| averageHeartRate | number?         |                                      |
| createdAt        | ISO-8601 string |                                      |

## Health Sync token
| field     | type            | notes                                            |
|-----------|-----------------|---------------------------------------------------|
| uid       | string          | owning user                                       |
| createdAt | ISO-8601 string |                                                    |

Doc id is `sha256(plaintext token)`. The plaintext token is shown to the user
exactly once (on generation, from `/settings`); only its hash is ever stored.
`users/{uid}.healthTokenHash` tracks the current hash so generating a new
token can delete the old `healthTokens/{hash}` doc, revoking it.

## Write paths
- **Nutrition**: browser → `POST /api/nutrition` (Firebase ID token) → OpenAI parse → Admin SDK write.
- **Workouts**: iOS Shortcut → `POST /api/health` (personal Health Sync token, resolved to a uid server-side) → Admin SDK upsert.
- **Health Sync token**: browser (signed in) → `POST/DELETE /api/settings/health-token` (Firebase ID token) → Admin SDK mint/revoke.

Client Firestore writes are disabled in `firestore.rules`; the browser only reads its own `users/{uid}/**` data (not the `users/{uid}` doc itself, nor `healthTokens/**`, both of which are Admin-SDK-only). All writes flow through server API routes using the Admin SDK.
