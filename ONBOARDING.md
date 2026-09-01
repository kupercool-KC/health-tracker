# Health Tracker — onboarding for a new Claude session

Personal Next.js/Firebase/OpenAI health-tracking web app (nutrition, workouts, steps, an AI chat
assistant). This is a **personal project for one user (Iddo)**, not a team codebase — treat any
production action (deploying, touching live data) with the same care you'd want for your own data.

## Where everything lives

- **Code**: this repo, on disk at
  `/Users/ikuperman/Library/CloudStorage/GoogleDrive-iddo.kuperman@teads.com/My Drive/health-tracker`
  (a Google Drive–synced folder, not a normal local path — the space in the path is real, quote it).
- **GitHub**: `github.com/kupercool-KC/health-tracker` (Iddo's personal GitHub account).
  Two branches: `dev` (integration branch — push work here) and `main` (production — Vercel
  auto-deploys `main` to the live app).
  **Standing rule: only merge `dev` → `main` when the user explicitly asks for it** ("push to prod",
  "deploy", "merge to main"). Every other change goes to `dev` and stays there until asked.
- **Hosting**: Vercel, project name `health-tracker` (org `team_LVCB4WF8gcziMlYAk7CtC3DL` — see
  `.vercel/project.json`). `main` → production; `dev` → a preview deployment.
  Production/preview URLs aren't hardcoded anywhere in this doc — check the user's Vercel
  dashboard or ask them for the current URL(s) if you need to open the live app.
- **Backend**: Firebase project `health-tracker-new-bf407`
  (console: `console.firebase.google.com` → that project). Firestore (database), Firebase Auth
  (Google sign-in only), Firebase Storage (uploaded meal/workout/step photos).
  Firestore layout: `users/{uid}/meta/{profile|goalHistory}`, `users/{uid}/meals/{date}`,
  `users/{uid}/workouts/{id}`, `users/{uid}/steps/{date}`, `users/{uid}/chatSessions/{id}`.
  Security rules: `firestore.rules` in this repo.
- **AI**: OpenAI API (`gpt-4o-mini`-class models) for chat, nutrition/workout/step parsing from
  text+photos, and intent classification. USDA FoodData Central API grounds calorie/protein
  numbers for named foods (falls back to a web search, then the model's own estimate).
- **Env vars** (local dev reads `.env.local`, already present in this repo — do not print its
  values into chat; production env vars are configured in the Vercel project settings, not this
  file): `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON` (Admin SDK — server-only routes),
  `NEXT_PUBLIC_FIREBASE_*` (client SDK config), `OPENAI_API_KEY`, `OPENAI_MODEL`,
  `USDA_FDC_API_KEY`, `HEALTH_INGEST_TOKEN` (Apple Health / Health Auto Export webhook auth).

## Architecture map

- `src/app/today` — today's dashboard (meals/workouts/steps, inline add forms).
- `src/app/history` — calendar strip, charts (calories/protein/steps/overall vs goal, with
  goal-change history annotated), day-detail drawer (now supports editing/deleting a logged meal).
- `src/app/profile` — goals, editable "Your info" (age/height/weight/activity/goals/workout
  types/diet/allergies/avoid-avoid-preferred foods), goal-history editor, Apple Health sync token.
- `src/app/onboarding` — one-question-per-screen wizard that calculates BMR/TDEE → calorie/protein
  goals; re-runnable from Profile, prefills from the existing profile if one exists.
- `src/app/ChatPanel.tsx` + `src/app/api/chat/route.ts` — the chat assistant: intent
  classification → log_meal/log_workout/log_steps/query_history/general_health/manage_meal,
  multi-photo upload support, RTL-safe number rendering for Hebrew.
- `src/lib/nutrition/parser.ts`, `src/lib/workout/parser.ts`, `src/lib/steps/parser.ts` —
  OpenAI-vision-backed parsers turning text/photos into structured entries.
- `src/lib/nutrition/usda.ts` — USDA grounding + web-search fallback for calorie/protein accuracy.
- `src/lib/goals/goalHistory.ts` — tracks *when* a calorie/protein goal changed, so History's
  charts apply the goal that was actually in effect on each past day.
- `src/lib/i18n/` — full English/Hebrew i18n, RTL-aware; **every user-facing string needs both
  `en` and `he` values**, and numbers embedded in Hebrew text need bidi-safe handling (see
  `ChatPanel.tsx`'s `isolateNumbersForBidi`).
- `firestore.rules` — security rules (client can read its own subtree; most writes go through
  Admin-SDK-backed API routes in `src/app/api/*`, not directly from the client).

## Working conventions

- Local commands: `npm run typecheck` and `npm run build` — always run both before committing;
  don't declare something fixed without them passing.
- Commit to `dev`, push, and stop there unless told to deploy to `main`/prod.
- This is a solo personal app: no CI, no other developers, no staging environment beyond the
  `dev` Vercel preview. Move fast, but don't skip the typecheck/build gate.
- Hebrew is a first-class language throughout — check RTL rendering for any UI change that
  touches text layout, not just that a translation key exists.
