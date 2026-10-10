# Spec: Apple Health import, full nutrients, progress & proactive insights

Status: **specified, not built** (2026-10-10). All decisions below were confirmed by Iddo on 2026-10-10. A fresh session can build from this document without re-asking; ask only if something here turns out to be impossible.

House rules for whoever builds this:
- Iddo is non-technical: report in Hebrew, numbered steps, exact links.
- Every new UI string needs `en` + `he` in `src/lib/i18n/strings.ts`; isolate numbers/units for bidi.
- Debug with real Firestore data, never guess from screenshots.
- Push flow: `gh auth switch -u kupercool-KC` → push `main` → ff `dev` → `gh auth switch -u iddokuperman-png`.
- Verify UI in the iOS simulator (local dev server + temporary test user, deleted afterwards) — see the session notes in `docs/ios-build.md`.
- The iOS app is a Capacitor shell loading the live site. Build 4 (pending, uploaded by Tomer) includes `@capgo/capacitor-health`, `@capacitor/app` and the HealthKit capability. **Everything here is web code; no new native build is needed** (only Phase B stage 2, background delivery, needs one).

Build order: **A → B → C → D** (D depends on A–C data).

---

## Confirmed decisions

| # | Topic | Decision |
|---|---|---|
| B1 | Duplicate workouts | Apple Health wins; an overlapping manual/chat workout is merged into it |
| B2 | Burned calories | Apple active kcal replaces the estimate; keep the existing `netCalorieBurnFactor` (50%) |
| B3 | Sleep + resting HR | Include now |
| B4 | Initial import | **60 days**, and auto-fill every profile parameter that the data supports |
| Q1 | Target weight/date | Ask in onboarding (optional) |
| Q2 | Nutrient targets | Defaults derived per user |
| Q3 | Diet style | Ask; targets always follow the user's answer |
| Q4 | Backfill old meals' nutrients | **No** — old meals stay without the new nutrients |
| Q5 | Weekly review | Sunday 20:00 (Israel), app + WhatsApp |
| Q6 | Proactive frequency | Max one insight per day in the app; WhatsApp gets only the weekly review unprompted |
| — | WhatsApp nutrients | Do **not** show the extra nutrients in WhatsApp confirmations/summaries for now |

---

## Phase A — Full nutrients and nutrient control

### Data
- `MealEntry` and `ParsedNutritionItem` (`src/lib/types.ts`): `carbs`, `fat`, `fiber` exist (optional). Add `sugar` (g), `saturatedFat` (g), `sodium` (mg), `nutrientsEstimated?: boolean` (true = model-only).
- `UserProfile`: add `dietStyle?: "balanced" | "lowCarb" | "highProtein" | "mediterranean" | "keto" | "custom"` and `nutrientTargets?: { carbsG, fatG, fiberG, sugarMaxG, satFatMaxG, sodiumMaxMg, source: "auto" | "manual" }`.

### Estimation
- `src/lib/nutrition/parser.ts`: prompt + zod schema return all six nutrients per item.
- `src/lib/nutrition/usda.ts`: also read USDA nutrient IDs 1005 carbs, 1004 fat, 1079 fiber, 2000 sugars, 1258 saturated fat, 1093 sodium; scale by grams like kcal/protein.
- Precedence per nutrient: user-stated value > label photo > USDA > model estimate (same as kcal/protein today).
- Only new meals get the new fields (Q4).

### Quality control
- Energy check: `4·protein + 4·carbs + 9·fat` within ±25% of kcal (skip when alcohol is present). Fail → one silent re-ask; still failing → keep kcal/protein, drop the inconsistent nutrients, set `confidence` low.
- Sanity caps per item: sodium ≤ 5000 mg, sugar ≤ carbs, satFat ≤ fat, fiber ≤ carbs. A failing value is dropped, the rest kept.
- Rejections go to the existing `agentFeedback` collection with the raw estimate.

### Targets (auto, recalculated when calorie goal, weight or diet style changes, unless `source: "manual"`)
| dietStyle | Carbs | Fat | Notes |
|---|---|---|---|
| balanced (default) | rest of kcal after protein and fat | 30% kcal | |
| lowCarb | 20% kcal | rest | |
| keto | ≤ 50 g | rest | |
| highProtein | rest | 25% kcal | protein goal already set separately |
| mediterranean | rest | 35% kcal | |
Fiber 14 g / 1000 kcal · sugar ≤ 10% kcal ("total sugar, estimate") · saturated fat ≤ 10% kcal · sodium ≤ 2300 mg. Status per nutrient: **below / in range / above** (fiber and carbs-in-lowCarb are "aim for at least / at most" accordingly).

### Display (app only)
- **Today**: under the calories/protein cards, a collapsed card "Nutrition breakdown / פירוט תזונתי". Collapsed: three chips for the nutrients furthest from target (e.g. "Sodium high", "Fiber low"). Expanded: a bar per nutrient with value / target and status colour; caption "Based on 3 of 5 meals with full data" when coverage < 100%.
- **Meal row expand**: the six values for that meal; "estimate" tag when `nutrientsEstimated`.
- **History**: new "Nutrients" chart group: 7/30-day daily averages per nutrient vs target line.
- **Profile → Goals**: diet style picker + the target per nutrient (editable; editing sets `source: "manual"`, with "Reset to automatic").
- Empty state (no data yet): "Full nutrition details appear for meals you log from now on."

### Lily
- App chat: agent state includes today's nutrient totals vs targets; Lily can answer ("how much sodium today?") and correct ("that was 800 mg sodium").
- WhatsApp: never adds nutrients to confirmations or the evening summary; answers only when the user explicitly asks.

### Acceptance
- A new meal logged in app or WhatsApp stores all six nutrients (or drops failing ones with a feedback row).
- Today card, meal expand, History chart and Profile targets render in en + he, light + dark, on iPhone width.

---

## Phase B — Apple Health import (stage 1)

### Data read (read-only; never write)
Workouts (type, start, end, duration, active kcal, distance, avg/max HR, source device) · daily steps · weight · body fat % · lean body mass · height · sleep (per night: in bed, asleep, stages if present) · resting heart rate (daily). Never import dietary data.

### Storage
- Workouts → existing `users/{uid}/workouts` with `source: "appleHealth"`, `externalId` = HealthKit UUID (doc id, dedupes re-imports), new `hkType` (raw Apple type), `device` (watch/phone).
- `users/{uid}/sleep/{date}` (night ending on `date`): `asleepMin`, `inBedMin`, `stages?`.
- `users/{uid}/vitals/{date}`: `restingHr`.
- Body fat / lean mass → existing `bodyMetrics/{date}` (merge, never overwrite a richer smart-scale entry of the same day).
- Sync state per device in localStorage (`appleHealth:anchor`, `appleHealth:lastSync`); server keeps `meta/healthSync` (`lastSyncAt`, `counts`) for display and for Lily.

### Workout type mapping (keep `hkType`; map to `WorkoutType`)
running ← running, treadmill · walking ← walking, hiking · cycling ← cycling, indoor cycling · swimming ← pool, open water · strength ← traditional/functional strength, core · yoga ← yoga, pilates, mind & body · hiit ← HIIT, cross training, mixed cardio · padel ← learned per user: the first time an unmapped racket type (tennis, paddle sports, racquetball, other) appears, Lily asks once "Was this padel?" and stores the answer with `remember` · other ← the rest, displayed with the Apple name.

### Merge rule (B1)
A manual/chat workout whose time range overlaps a Health workout by ≥ 50% (or starts within ±30 min when it has no end) and maps to the same type is merged: the Health record stays, the manual one is deleted, its free-text note is copied to the Health record. If types differ, keep both and let Lily ask "Is this the same workout?" once.

### Burned calories (B2)
Daily burned = sum of workout active kcal from Health (or the estimate for manual workouts) × `netCalorieBurnFactor`. Do not add Apple's all-day active energy (avoids double counting with steps).

### Sync behaviour
- On connect: import **60 days** (B4).
- Then incremental on every app open/foreground (existing `AppleHealthAutoSync`), using the workouts anchor; steps/sleep/HR re-read for the last 3 days.
- Profile card shows "Last synced 2 min ago · 42 workouts, 60 nights of sleep", Sync now, Disconnect.

### Auto-fill from data (B4)
From 60 days of data, compute and pre-fill (user always confirms in onboarding; afterwards, auto-update weekly with a small "updated from Apple Health" note in Profile):
- height, current weight, body fat (latest)
- workout types (any type with ≥ 2 sessions)
- activity level (sessions/week: 0–1 sedentary, 1–3 light, 3–5 moderate, 6–7 intense, >7 very intense)
- average daily steps (median of 60 days) → `averageDailySteps`; suggested `stepGoal` = median rounded up to the next 500
- typical sleep (median asleep minutes) and resting HR baseline (for insights)

### Onboarding flow (native app only; the web keeps today's flow)
1. **New step 0 — "Do you track with a watch or the Health app?"** Options: "Yes, connect Apple Health" / "Not now".
2. Yes → **explainer screen**: what we read (list above), read-only, never shared for ads, used by Lily to coach you; button "Continue to Apple permissions". (iOS shows the permission sheet only once and hides read denials, so this screen must come first.)
3. Permission sheet → import with a progress state "Reading 60 days of data…".
4. **Summary screen**: "Found 38 workouts (14 runs, 20 strength, 4 yoga), sleep for 55 nights, average 7,800 steps." Button "Use this to fill my profile".
5. Existing steps 1–6 open **pre-filled** (basic stats, goal, activity, workout types, diet, steps), each value tagged "from Apple Health" and editable.
6. Nothing came back (denied or no data) → message "We didn't receive data. You can allow access in Settings → Health → Data Access & Devices → Lily" + continue manually.
7. "Not now" → current flow; Profile keeps the Connect card.

### Compliance
- Update the AI-consent screen (`src/app/ConsentGate.tsx`) and `/privacy` to state that Apple Health data is used to coach the user and is processed by OpenAI for the chat; never used for advertising; not stored in iCloud.
- App Store privacy labels: Health & Fitness already declared; add sleep and heart rate to the description in `docs/app-store-listing.md`.

### Stage 2 (later, needs a native build)
Background delivery (HKObserverQuery + entitlement) so workouts arrive with the app closed.

---

## Phase C — Goal, metrics and the Progress screen

### Goal (onboarding step 2 + Profile)
After choosing the primary goal: optional **target weight** and **target date** (date picker with quick picks: 8 / 12 / 16 weeks). Validation: max safe pace 1% of body weight per week; if the chosen date needs more, show "That's faster than 1% a week. Suggested date: 12 March" and preselect it. Maintain/build-muscle goals skip target weight unless the user wants one.

### Nightly metrics (deterministic; new cron endpoint pinged by cron-job.org like the reminders)
- `users/{uid}/dailyStats/{date}`: kcal, protein, six nutrients, net balance, workouts (count, minutes, kcal by type), steps, weight, sleep, resting HR, meals logged, nutrient coverage.
- `users/{uid}/metrics/current`: 7/28-day averages, adherence (% days within ±10% of calorie goal; % days protein ≥ 90% of goal), logging consistency (% days with ≥ 2 meals), streaks, weight trend (EMA, weekly rate), expected vs actual weight change (7700 kcal ≈ 1 kg), ETA to target at current pace, required daily balance to hit the target date.

### Progress screen (rename the **Weight** tab to **Progress / התקדמות**; weigh-ins move inside it)
Top to bottom:
1. **Goal header**: "‎-4.2 kg of -8 kg · on track for 14 Feb" with a status pill: ahead / on track / behind / not enough data.
2. **Timeline chart**: start → today → target. Smoothed weight trend line, daily weigh-in dots, dashed planned line to the target, milestone ticks (every 25%). Tap a milestone → date reached.
3. **Weekly scorecard** (this week vs last): calorie adherence days, protein days, workouts vs usual, average sleep, logging days, weight trend — each with up/down arrow.
4. **Expected vs actual** card when the gap is > 1 kg over 4 weeks: "Your logged deficit predicts -3.1 kg; the scale shows -1.4 kg. Common reasons: unlogged snacks, weekend meals, water from salty food." (wording from D detectors).
5. **Weigh-ins list** (current Weight screen content).
Empty state (< 7 days of data): "Your progress view fills in after a week of logging. So far: 4 days." Without a target: header shows trend only and a "Set a target" button.

---

## Phase D — Proactive insights

### Pipeline
Nightly after metrics: **detectors** (pure functions over `dailyStats` + `metrics`) emit candidates `{type, evidence numbers, severity, suggestedAction}` → **ranker** → **phrasing** by the mini model in the user's language, numbers passed in and never invented → stored in `users/{uid}/insights/{id}` (`status: new | shown | acted | dismissed`, `createdAt`, `expiresAt`).

### Detectors (first set; each needs ≥ 5 logged days in its window)
| Detector | Trigger | Suggested action |
|---|---|---|
| Protein gap at breakfast | breakfast avg < 15 g on ≥ 4 of 7 days | two breakfast options from the user's regular foods that add ~30 g |
| Rest-day protein | protein hit on workout days but not rest days | reminder at usual lunch time |
| Weekend gap | Fri–Sat avg kcal > weekday avg + 400 | plan one weekend meal ahead |
| Plateau | weight trend flat ≥ 14 days with logged deficit ≥ 300/day | check logging accuracy; sodium note if high |
| Sodium high (app only) | above target ≥ 4 of 7 days | lower-salt swaps from their regular foods |
| Fiber low | < 60% of target ≥ 5 of 7 days | add vegetables/legumes suggestion |
| Training drop | sessions this 2 weeks < 60% of previous 4-week rate | short session suggestion matching their usual types |
| Sleep and intake | nights < 6 h followed by intake > avg + 300 on ≥ 3 occasions | earlier wind-down reminder |
| Late eating | share of kcal after 21:00 rising week over week | earlier dinner reminder |
| Positive | 7/7 protein days, streaks, ahead of schedule | none (celebrate) |

### Ranking
score = goal relevance (plateau/weekend gap weigh more for loss goals; protein/training for muscle) × effect size × novelty (same type not within 7 days; dismissed types down-weighted per user). Daily: pick the top one if score passes a threshold; otherwise show nothing.

### Display and behaviour
- **Today**: "Insight / תובנה" card above Meals, max one per day: one-sentence finding, one-sentence why it matters for *their* goal, action button (e.g. "Show breakfast options" opens chat with Lily pre-prompted; "Remind me" creates a reminder via the existing reminders model), and "Not useful" (dismiss). Swipe/close = shown.
- **Weekly review** (Sunday 20:00): app card at top of Today until Monday night + WhatsApp message. WhatsApp content: calories and protein adherence, weight trend, workouts count, one sentence from the top insight that doesn't mention the new nutrients. Respects reminder settings (it is a new reminder type `weeklyReview`, on by default, toggle in Profile).
- **Every 4 weeks**: if trend is off target by > 25%, the review proposes a new calorie goal ("Lower to 1,850 kcal to reach your date?") with Accept / Keep. Nothing changes without Accept.
- **Lily**: agent state gets `metrics/current` summary + up to 3 active insights; she may reference them when relevant, ask one follow-up question per insight at most, and store answers with `remember`. She never sends unprompted WhatsApp messages besides reminders and the weekly review.

### Memory
Weekly job writes `Memory.workoutPatterns` (exists) and a new `Memory.eatingPatterns` (e.g. "big dinners, light breakfasts, weekend +500 kcal") from `dailyStats`; both shown to Lily in app and WhatsApp.

### Guardrails
No medical advice or diagnosis; calorie floor (never suggest below max(1200, BMR×1.1)); max loss pace 1%/week; neutral, non-judgmental wording (no "bad", "failed", "cheat"); confidence wording when coverage is partial; at most one proactive item per day.

---

## Acceptance checklist (end to end)
1. New user on iPhone: onboarding asks about Apple Health → explainer → permission → 60-day summary → pre-filled steps → final profile with nutrient targets and timeline preview.
2. A workout recorded on the watch appears on Today within one app open; a chat-logged duplicate merges.
3. Today shows the nutrition breakdown; WhatsApp confirmations still show only calories + protein.
4. Progress tab shows goal header, timeline, scorecard; empty states correct before 7 days.
5. One insight appears on Today with a working action; dismiss works; it doesn't repeat within 7 days.
6. Sunday 20:00 weekly review arrives on WhatsApp and in the app.
7. All new strings en + he; light + dark; iPhone width; verified in the simulator.
