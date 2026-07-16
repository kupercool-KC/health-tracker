# Data model

All data is namespaced per user under `users/{uid}`.

```
users/{uid}
  ├── nutrition/{entryId}     → NutritionEntry
  └── workouts/{externalId}   → Workout   (doc id = HKWorkout UUID, for dedupe)
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
| field            | type            | notes                                |
|------------------|-----------------|--------------------------------------|
| id / externalId  | string          | HKWorkout UUID (also the doc id)     |
| userId           | string          | owner uid                            |
| activityType     | string          | HKWorkoutActivityType name           |
| startedAt/endedAt| ISO-8601 string |                                      |
| durationSec      | number          |                                      |
| activeEnergyKcal | number?         |                                      |
| distanceMeters   | number?         |                                      |
| averageHeartRate | number?         |                                      |
| createdAt        | ISO-8601 string |                                      |

## Write paths
- **Nutrition**: browser → `POST /api/nutrition` (Firebase ID token) → OpenAI parse → Admin SDK write.
- **Workouts**: iOS Shortcut → `POST /api/health` (shared-secret Bearer token) → Admin SDK upsert.

Client Firestore writes are disabled in `firestore.rules`; the browser only reads its own data. All writes flow through server API routes using the Admin SDK.
