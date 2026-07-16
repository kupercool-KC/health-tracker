# Health Tracker

Log nutrition (calories + protein) via chat and food photos, store it in
Firebase, and sync workouts from Apple Health.

## Stack
- **Next.js (App Router) + TypeScript** — UI + server API routes.
- **Firebase** — Auth + Firestore (client reads; server writes via Admin SDK) + Storage.
- **OpenAI (vision)** — parses chat/image input into `{ calories, protein }`.
- **Apple Health → iOS Shortcut** — pushes workouts to a token-protected endpoint.

## Structure
```
src/
  app/
    layout.tsx              app shell
    page.tsx                server wrapper (force-dynamic) around NutritionLogger
    NutritionLogger.tsx     nutrition-logging UI (client, behind sign-in)
    dashboard/
      page.tsx              server wrapper (force-dynamic)
      Dashboard.tsx          daily/weekly totals (client, reads Firestore directly)
    globals.css
    api/
      nutrition/route.ts    POST — log food (Firebase ID token auth)
      health/route.ts       POST — Apple Health ingest (shared-secret auth)
  lib/
    types.ts                domain models
    auth.ts                 server auth helpers
    firebase/client.ts      browser SDK
    firebase/admin.ts       server Admin SDK
    firebase/useAuth.ts     client hook: Google sign-in/out, current user
    firebase/uploadImage.ts client upload of food photos to Storage
    dashboard/queries.ts    client Firestore reads + day-bucketing for totals
    nutrition/parser.ts     OpenAI vision parsing
firestore.rules             per-user isolation, client writes disabled
storage.rules                per-user isolation for uploaded food photos
docs/data-model.md          Firestore layout
```

## Setup
1. `cp .env.example .env.local` and fill in Firebase + OpenAI values.
2. Generate the Health ingest secret: `openssl rand -hex 32` → `HEALTH_INGEST_TOKEN`.
3. `npm install`
4. `npm run dev`

> **Note:** this project currently lives inside a Google Drive folder. Move it
> to a local path (e.g. `~/dev/health-tracker`) before `npm install` — Drive
> syncing `node_modules` causes lock/perf issues.

## Apple Health sync (iOS Shortcut)
Create a Shortcut that:
1. Gets recent workouts from Health (Find Health Samples → Workouts).
2. Builds a JSON body: `{ "userId": "<your-uid>", "workouts": [ ... ] }` matching
   the `Workout` shape in `docs/data-model.md` (use each workout's UUID as `externalId`).
3. `POST`s to `https://<your-host>/api/health` with header
   `Authorization: Bearer <HEALTH_INGEST_TOKEN>`.
4. Optionally trigger it via a Personal Automation "When a Workout ends".

## Next steps (not yet built)
- [x] **Firebase Auth**: Google sign-in via `src/lib/firebase/useAuth.ts`, gating
  `NutritionLogger` (rendered from `page.tsx`, which is `force-dynamic` since
  this is per-user authenticated data).
- [x] **Read/history views**: `/dashboard` (`src/app/dashboard/`) reads Firestore
  directly from the browser (per-user rules) and shows today's totals, a
  7-day rolling total, and a daily breakdown table incl. workout minutes/kcal.
- [x] **Image storage**: food photos upload to Firebase Storage client-side
  (`src/lib/firebase/uploadImage.ts`, path `users/{uid}/nutrition-images/...`,
  access restricted by `storage.rules`) and only the resulting download URL is
  sent to `/api/nutrition`.

## Remaining (needs your decision before deploying)
- **Deployment**: the `/api/health` endpoint is a public HTTPS surface. Decide
  hosting + exposure/auth model before deploying (do not expose unauthenticated).

> You must enable the **Google** sign-in provider in the Firebase console
> (Authentication → Sign-in method) for `signInWithPopup` to work.
```
