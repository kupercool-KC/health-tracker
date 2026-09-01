# Health Tracker

Personal Next.js / Firebase / OpenAI health-tracking app (nutrition, workouts,
steps, AI chat). One user. Full project context — architecture map, data model,
env vars, hosting — is in [`ONBOARDING.md`](./ONBOARDING.md); read it before
non-trivial work.

## Engineering principles (apply to every change)

Follow the discipline in `~/.claude/skills/engineering-principles` on every
request here — no need to invoke the skill by name:

1. **Think before coding.** Read the relevant file(s) first. State assumptions or
   ask; don't guess past what's unclear. Name a simpler approach if one exists.
2. **Simplicity ladder.** Before writing new code: does it need to exist? Does
   this repo already solve it (reuse/extend beats a parallel implementation)?
   A built-in? An installed dep? One line? Otherwise the minimum that works —
   nothing speculative. Never trades away correctness/security/data-loss safety.
3. **Surgical changes.** Touch only what the task needs. No drive-by reformatting
   or refactoring of working code. Match existing style. Every changed line
   traces to the request. Flag unrelated debt, don't fix it.
4. **Goal-driven verification.** Name the check that proves the task is done and
   run it (see gate below). "Fix the bug" → reproduce it first, then fix.
5. **Token-aware commands.** `rtk` is installed and wired via hook — high-volume
   commands are filtered automatically.

### Repo-specific reuse notes (ladder step 2)

- **Auth in API routes** → `getUidFromRequest` / `getAuthFromRequest`
  (`src/lib/auth.ts`). Never hand-roll Firebase token verification.
- **"Today" as a date key** → `localDateKey()` (`src/lib/dashboard/queries.ts`).
  Never `toISOString().slice(0,10)` — it mislabels the day off-UTC.
- **Surfacing an API error + detail in the UI** → `apiErrorMessage()` (currently
  copied in `Today.tsx` and `ChatPanel.tsx`; extend/dedupe rather than add a
  third copy).
- **"User input → structured entry" features** → route through the existing
  parser (`src/lib/{nutrition,workout,steps}/parser.ts`) → `/api/*` flow. The
  voice-dictation feature followed this: transcribe → feed the normal text path.
- **Any user-facing string** → add `en` + `he` to `src/lib/i18n/strings.ts`;
  wrap embedded numbers in `<bdi dir="ltr">`, keep unit words outside the
  `<bdi>`. Check RTL rendering, not just that the key exists.

## Verification gate (before declaring anything done)

```bash
npm run typecheck && npm run build
```

Both must pass. Don't call a change fixed without them.

## Workflow

- Work goes on `dev`, committed and pushed there. Only merge `dev` → `main`
  (production, auto-deploys) when explicitly asked ("push to prod" / "deploy").
- Solo project: no CI, no staging beyond the `dev` Vercel preview. Move fast,
  don't skip the typecheck/build gate.
