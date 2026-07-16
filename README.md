# Health Tracker

Log nutrition (calories + protein) via chat and food photos, store it in
Firebase, and sync workouts from Apple Health.

## Stack
- **Next.js (App Router) + TypeScript** — UI + server API routes.
- **Firebase** — Auth + Firestore (client reads; server writes via Admin SDK) + Storage.
- **OpenAI (vision)** — parses chat/image input into `{ calories, protein }`.
- **Apple Health → iOS Shortcut** — pushes workouts to `/api/health`, authenticated
  by a personal per-user token (minted from `/settings`, not a shared secret).

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
    settings/
      page.tsx              server wrapper (force-dynamic)
      Settings.tsx           generate/revoke your personal Health Sync token
    globals.css
    api/
      nutrition/route.ts    POST — log food (Firebase ID token auth)
      health/route.ts       POST — Apple Health ingest (personal token auth)
      settings/health-token/route.ts  POST mint / DELETE revoke a personal token
  lib/
    types.ts                domain models
    auth.ts                 server auth helpers (Firebase ID token verification)
    healthToken.ts           mint/resolve/revoke per-user Health Sync tokens
    firebase/client.ts      browser SDK
    firebase/admin.ts       server Admin SDK
    firebase/useAuth.ts     client hook: Google sign-in/out, current user
    firebase/uploadImage.ts client upload of food photos to Storage
    dashboard/queries.ts    client Firestore reads + day-bucketing for totals
    nutrition/parser.ts     OpenAI vision parsing
firestore.rules             per-user isolation; users/{uid} + healthTokens locked to Admin SDK only
storage.rules                per-user isolation for uploaded food photos
docs/data-model.md          Firestore layout
```

## Setup
1. `cp .env.example .env.local` and fill in Firebase + OpenAI values.
2. `npm install`
3. `npm run dev`

> **Note:** this project currently lives inside a Google Drive folder. Move it
> to a local path (e.g. `~/dev/health-tracker`) before `npm install` — Drive
> syncing `node_modules` causes lock/perf issues.

> You must enable the **Google** sign-in provider in the Firebase console
> (Authentication → Sign-in method) for `signInWithPopup` to work.

## Deployed
Live at **https://health-tracker-sepia.vercel.app** (Vercel project `kuper/health-tracker`).
Env vars are set in the Vercel dashboard (Project Settings → Environment
Variables) — `.env.local` is never read by Vercel, values are pushed
separately via `vercel env add`. `HEALTH_INGEST_TOKEN` is no longer used by
the app (superseded by per-user tokens below) but is harmless to leave set.

## Apple Health sync (iOS Shortcut)
Each user mints their **own** token from `/settings` (Firebase-Auth-gated —
click "Generate new token", copy it immediately, it's shown once). The token
itself identifies the user, so the Shortcut no longer sends a `userId`.

Build a Shortcut that:
1. Gets recent workouts from Health (Find Health Samples → Workouts).
2. Builds a JSON body: `{ "workouts": [ ... ] }` matching the `Workout` shape
   in `docs/data-model.md`. Shortcuts has no stable HKWorkout UUID action, so
   use a synthetic `externalId` = `activityType + "-" + startedAt (ISO)`.
3. `POST`s to `https://health-tracker-sepia.vercel.app/api/health` with header
   `Authorization: Bearer <your personal token from /settings>`.
4. Optionally trigger it via a Personal Automation on a schedule.

Generating a new token from `/settings` immediately revokes the previous
one — update the Shortcut if you ever regenerate.

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
- [x] **Per-user Health Sync tokens**: `/settings` mints a personal token
  (`src/lib/healthToken.ts`, hash stored in `healthTokens/{hash}`) instead of
  everyone sharing one `HEALTH_INGEST_TOKEN` — `/api/health` resolves the uid
  from the token itself, so a request can no longer claim someone else's uid.
```
