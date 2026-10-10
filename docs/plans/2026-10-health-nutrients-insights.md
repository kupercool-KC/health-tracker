# Plan: Apple Health import, full nutrients, trends & insights

Status: **planned, not built** (2026-10-10). Written to be picked up by a fresh session. Iddo (owner) is non-technical; explain in Hebrew with numbered steps. Every new UI string needs en + he (bidi-guarded numbers/units). Debug with real Firestore data. Push flow: `gh auth switch -u kupercool-KC`, push `main`, ff `dev`, switch back to `iddokuperman-png`.

Native context: the iOS app is a Capacitor shell loading the live site. Build 4 (pending upload by Tomer) contains `@capgo/capacitor-health` (HealthKit, read steps+weight today), `@capacitor/app` (build reporting to `appBuilds/`) and the HealthKit capability. Everything in Phases A–D below is **web code only**; no new native build is needed unless noted.

---

## Phase A — Full nutrients ("בקרה תזונתית")

Goal: every meal carries a full nutrient profile, the app tracks it against daily targets, and flags implausible estimates. WhatsApp does **not** show the extra nutrients yet (confirmations and summaries stay calories + protein).

**Data model** (`src/lib/types.ts`)
- `MealEntry` / `ParsedNutritionItem` already have `carbs`, `fat`, `fiber` (optional, rarely filled). Add: `sugar` (g), `saturatedFat` (g), `sodium` (mg). Keep all optional so old entries stay valid.
- Add `nutrientsEstimated?: boolean` (true when values are model-only, not USDA/label/explicit).

**Estimation** (`src/lib/nutrition/parser.ts`, `usda.ts`)
- Parser prompt + zod schema request all six nutrients per item.
- USDA grounding: also read nutrient IDs 1005 carbs, 1004 fat, 1079 fiber, 2000 sugars, 1258 saturated fat, 1093 sodium; scale by grams like kcal/protein today.
- Explicit values from the user ("800 מ״ג נתרן") or a label photo win, same precedence as kcal/protein.

**Quality control**
- Energy consistency check: `4·protein + 4·carbs + 9·fat` within ±25% of kcal (alcohol excepted) → otherwise mark low confidence and re-ask the model once.
- Hard sanity caps (e.g. sodium > 5000 mg per item, sugar > carbs) → reject value, keep the rest.
- Log rejections to the existing `agentFeedback` flow for review.

**Daily targets** (new `profile.nutrientTargets`, editable in Profile, defaults derived from calorie goal)
- Carbs and fat: default split of remaining kcal after protein (fat 25–35% of kcal).
- Fiber: 14 g per 1000 kcal. Sodium: ≤ 2300 mg. Saturated fat: ≤ 10% kcal. Sugar: ≤ 10% kcal (labelled "total sugar, estimate").
- Status per nutrient: below / in range / above.

**UI (app only)**
- Today: collapsible "Nutrition breakdown" card with bars vs targets; meal row expand shows that meal's nutrients.
- History: 7/30-day averages per nutrient vs target.
- Coverage note when part of the day lacks nutrient data ("3 of 5 meals have full data").
- Lily in the **app** chat gets daily nutrient totals in state and can answer/correct them. In WhatsApp she answers only if explicitly asked; she never adds them to confirmations.

**Old meals**: leave empty by default. Optional one-off backfill (re-estimate from name + grams with the mini model) — needs Iddo's OK because of API cost.

---

## Phase B — Apple Health import (stage 1)

Defaults below were recommended to Iddo; he replied "מעולה" — treat as accepted but confirm items 1–4 in one line before building.

**Read types**: workouts (type, start/end, duration, active kcal, distance, avg/max HR, source), daily steps (exists), weight (exists), body fat %, lean body mass. Later: sleep, resting HR. Never import dietary data (Lily is the nutrition source; avoid double counting).

**Workout mapping** — keep Apple's raw type in a new `hkType` field; map to our `WorkoutType`:
running ← running, treadmill · walking ← walking, hiking · cycling ← cycling, indoor cycling · swimming ← pool/open water · strength ← traditional/functional strength, core · yoga ← yoga, pilates, mind & body · hiit ← HIIT, cross training, mixed cardio · padel ← no Apple type; learn per user (tennis/paddle sports/other) via a remembered fact · other ← rest, shown by raw name.

**Decisions (defaults)**
1. Duplicates: Apple Health wins. A manual/chat workout overlapping in time (±30 min) and type is merged into the Health one (keep user notes).
2. Burned calories: use Apple's active kcal instead of the estimate, keep the existing `netCalorieBurnFactor` (50%) discount.
3. Sleep + resting HR: later phase.
4. Initial backfill: 30 days. Incremental sync with the plugin's anchor (`queryWorkouts({anchor})`), stored per device.

**Onboarding** (`src/app/onboarding/Onboarding.tsx`, app only, `isNativeApp`)
1. New early step: "Do you use a smartwatch or the iPhone Health app?"
2. Yes → explainer screen (what we read, read-only, why) → button triggers the HealthKit sheet. The sheet can be shown **once**; a read denial is invisible to the app, so the explainer must come first.
3. After grant: import 30 days, show "Found 14 workouts: 6 runs, 8 strength", and pre-fill workout types + activity level in later steps.
4. No / denied / no data → continue normally; Profile keeps a Connect button and, if nothing arrives, the Settings path (Settings → Health → Data Access & Devices → Lily).

**Compliance**: Apple requires disclosure + consent before HealthKit data reaches a third party. Update the AI-consent screen and privacy policy to say Apple Health data is processed by OpenAI for the chat. Never use it for ads; never store it in iCloud.

**Stage 2 (later, needs a native build)**: background delivery (HKObserverQuery) so data arrives with the app closed.

---

## Phase C — Metrics engine and progress timeline

**Goal definition** (Profile + onboarding): add optional `targetWeightKg` and `targetDate`. Without them the timeline uses the goal type only.

**Nightly rollup** (deterministic, server-side, new cron endpoint on the existing cron-job.org pattern)
- `users/{uid}/dailyStats/{date}`: kcal, protein, all nutrients, net balance, workouts (count, minutes, kcal by type), steps, weight, logged-meal count.
- `users/{uid}/metrics/current`: 7- and 28-day averages, adherence (% days within calorie band, % days protein hit), logging consistency, streaks, smoothed weight trend (EMA) and weekly rate.
- Projection: expected weight change from average net balance (7700 kcal ≈ 1 kg) vs actual trend → gap diagnosis (likely under-logging, water/sodium, or on track). ETA to target at current pace; required daily balance to hit `targetDate`.

**Progress screen** (new tab or part of History)
- Timeline: start → today → target, actual weight trend vs projected line, milestones (every 2 kg / 25%).
- Weekly scorecard: calorie adherence, protein days, workouts vs usual, logging days, weight trend.
- All numbers come from `metrics/current`; no LLM in this screen.

---

## Phase D — Proactive insights layer

**Pipeline**: deterministic detectors produce candidate insights with evidence → rank → LLM (mini model) only phrases the chosen one in the user's language. The LLM never invents numbers.

**Detector catalog (first set)**
- Protein short on rest days / at breakfast.
- Weekend vs weekday calorie gap.
- Plateau ≥ 14 days despite a deficit (suggest logging accuracy or sodium/water).
- Sodium above target ≥ 4 of 7 days (app only).
- Fiber consistently low.
- Workout frequency down vs previous 4 weeks; new favourite activity.
- Late-evening eating share rising.
- Positive: streaks, ahead of schedule, protein goal hit 7/7.

**Ranking**: relevance to the user's goal × size of effect × novelty (same insight not repeated within 7 days); minimum data threshold (≥ 5 logged days in window) before any claim.

**Surfaces**
- Today: one "Insight of the day" card with a concrete micro-action (e.g. two breakfast options from the user's regular foods that add 30 g protein) and optional "set a reminder".
- Weekly review (Sunday evening): app card + short WhatsApp message (calories, protein, weight, workouts only; no extra nutrients in WhatsApp for now).
- Lily: current top insights + `metrics/current` summary in agent state, so she references them naturally and can ask one follow-up question; answers go to memory via `remember`.
- Every 4 weeks: suggest recalibrating the calorie goal when the trend is off; applies only after the user confirms.

**Memory**: weekly job writes `Memory.workoutPatterns` (field exists) and an eating-pattern summary from `dailyStats`; Lily sees both in every conversation (app + WhatsApp).

**Feedback loop**: `users/{uid}/insights/{id}` with status shown / acted / dismissed; dismissed types are down-ranked for that user.

**Guardrails**: no medical advice; calorie floor (never suggest below a safe minimum); neutral, non-shaming language (eating-disorder sensitivity); confidence wording when data is thin; max one proactive message per day.

---

## Order and dependencies
1. **A** nutrients (insights depend on it).
2. **B** Apple Health stage 1 (workout data quality).
3. **C** metrics + progress screen.
4. **D** insights + weekly review.

## Open questions for Iddo
1. Confirm Phase B defaults 1–4.
2. Ask target weight and target date in onboarding? (recommended: yes, optional)
3. Nutrient target defaults OK, or a specific diet (e.g. low-carb)?
4. Backfill old meals' nutrients (small API cost)?
5. Weekly review day/time (default Sunday 20:00) and whether it also goes to WhatsApp.
6. Max proactive frequency (default: one insight per day in the app, none unprompted in WhatsApp except the weekly review).
