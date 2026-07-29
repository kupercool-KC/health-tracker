# Data model

All data is namespaced per user under `users/{uid}`.

```
users/{uid}                       → { healthTokenHash? }  (server-only; never client-readable)
users/{uid}/meta/profile          → UserProfile   (client read/write — own uid only)
users/{uid}/meta/memory           → Memory        (client read/write — own uid only)
users/{uid}/meta/alerts           → Alerts        (client read/write — own uid only)
users/{uid}/meals/{date}          → MealDay        (date = yyyy-mm-dd; client read, server write)
users/{uid}/workouts/{externalId} → Workout   (doc id = externalId, for dedupe; client read, server write)
users/{uid}/chatSessions/{id}     → ChatSession    (client read/write own — but message content only via server, see below)
healthTokens/{sha256(token)}      → { uid, createdAt }  (server-only; never client-readable)
appConfig/nutritionParser         → NutritionParserConfig  (admin-uid only, see src/lib/admin.ts)
sharedChats/{shareId}             → SharedChat     (public read, Admin-SDK-only write)
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

`POST /api/nutrition` upserts into this doc inside a Firestore transaction
(read existing entries, append, recompute totals, write back) rather than
creating a new doc per entry — the client just needs one doc read per day to
get today's totals, no range query needed. A single parse can produce
several `MealEntry` rows at once (one per distinct food identified — see
`ParsedNutritionItem` below), all appended in the same transaction.
`DELETE`/`PATCH /api/nutrition` remove or edit a single entry by id, same
recompute-totals-in-a-transaction pattern.

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

## ChatSession (users/{uid}/chatSessions/{sessionId})
| field     | type            | notes                                        |
|-----------|-----------------|-----------------------------------------------|
| id        | string          | also the doc id                               |
| title     | string          | auto-generated by the model after the first exchange |
| messages  | ChatMessage[]   | `{ role: "user"\|"assistant", content, createdAt, pendingMeal?, pendingMealAction? }` |
| createdAt / updatedAt | ISO-8601 string | |

The client can rename (`title`) or delete its own sessions directly
(`firestore.rules` allows read/write for the owning uid), but message
*content* is only ever produced by `POST /api/chat` (Admin SDK) — a client
write can't fabricate an assistant reply.

- `pendingMeal: { items: ParsedNutritionItem[], imageUrl? }` — proposed, not
  yet saved. A single message can describe several distinct foods (e.g. "2
  schnitzels and a salad"), so `items` may have more than one entry —
  confirming it calls `POST /api/nutrition` with `parsed: { items }`
  attached, which writes one `MealEntry` per item (see below).
- `pendingMealAction: { action: "delete"|"update", date, entryId, entryName, changes? }`
  — proposed edit/delete of an *already-logged* entry (the `manage_meal`
  chat intent, e.g. "delete the peach" or "yesterday's schnitzel was
  actually 300 calories"), resolved by
  `src/lib/chat/chat.ts#resolveMealAction` against the last 14 days of
  entries (not just today — the model is told today's date and matches by
  both date and name, since "date" isn't otherwise inferable from the
  server's timezone-less context). Confirming it calls `DELETE`/`PATCH
  /api/nutrition` against the matched entry's actual date.

## SharedChat (sharedChats/{shareId})
A public, read-only **snapshot** — not a live view — of a `ChatSession`'s
`title`+`messages` at the moment `POST /api/chat/share` was called. `shareId`
is `crypto.randomBytes(16).toString("hex")`, generated server-side; the ID
itself is the only thing gating access (same posture as an unlisted link),
which is why `firestore.rules` can safely allow `read: if true` on this
collection specifically without touching the per-user rules.

## NutritionParserConfig (appConfig/nutritionParser)
`{ systemPrompt, model, temperature, seed, updatedAt }` — edited from
`/admin`, read by `parseNutrition()` (`src/lib/nutrition/parser.ts`) at
request time via the Admin SDK. Falls back to
`src/lib/nutrition/configDefaults.ts` if unconfigured. Gated to a single
hardcoded uid, both in `src/lib/admin.ts` and mirrored literally in
`firestore.rules` (rules can't import JS constants).

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
- **Nutrition**: browser → `POST /api/nutrition` (Firebase ID token) → OpenAI parse (or an already-parsed `parsed` payload, from the chat confirm flow) → Admin SDK transaction upserting `meals/{date}`.
- **Workouts**: `POST /api/health` (personal Health Sync token, resolved to a uid server-side) → Admin SDK upsert.
- **Health Sync token**: browser (signed in) → `POST/DELETE /api/settings/health-token` (Firebase ID token) → Admin SDK mint/revoke.
- **Profile/memory/alerts**: browser (signed in) → direct Firestore client writes to `users/{uid}/meta/*` (allowed by `firestore.rules` for the owning uid).
- **Chat**: browser → `POST /api/chat` (Firebase ID token) → intent classification → Admin SDK read/write of the session doc. Session `title` rename / doc delete can also happen directly from the client.
- **Chat share**: browser (signed in) → `POST /api/chat/share` → Admin SDK snapshot into `sharedChats/{shareId}`. That doc is then publicly readable, no auth.
- **Admin config**: browser (admin uid only) → direct Firestore client write to `appConfig/nutritionParser`.

Everything else stays Admin-SDK-only: the browser reads its own
`users/{uid}/{meals,workouts,chatSessions}/**` and `users/{uid}/meta/**`,
plus the public `sharedChats/**`, but never the `users/{uid}` doc itself or
`healthTokens/**`.
