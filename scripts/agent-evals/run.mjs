// Regression suite for the chat agent — every case is a real failure from production chats.
// Usage: node --env-file=.env.local scripts/agent-evals/run.mjs [caseName] [runsPerCase]
// Needs `next dev -p 3111` running (dev-only /api/dev/agent-eval; all writes are stubbed).
const BASE = process.env.EVAL_BASE ?? "http://localhost:3111";
const UID = "Jw9kXMN8aucpw53kqaAw12gtlaA2";
const TODAY = "2026-10-01";
const NOW = "2026-10-01T06:14:00.000Z";
const YESTERDAY = "2026-09-30";

const u = (content) => ({ role: "user", content, createdAt: NOW });
const a = (content) => ({ role: "assistant", content, createdAt: NOW });
const ride = (min, km = 25, kcal = 600) => ({ type: "רכיבה על אופניים", durationSec: min * 60, distanceMeters: km * 1000, calories: kcal, date: TODAY });
const item = (description, calories, protein) => ({ description, calories, protein });

const cases = [
  {
    name: "bike_garbled_voice",
    message: "50 ל-5 דקות שרפתי 600 קלוריות ועשיתי 25 קילומטרים.",
    check: (o) => [
      ["did not draft a 5-minute ride", !o.draft.workout || o.draft.workout.durationSec !== 300],
      ["asks the user a question", /\?/.test(o.replyContent)],
    ],
  },
  {
    name: "bike_correction_star",
    prior: [u("50 ל-5 דקות שרפתי 600 קלוריות ועשיתי 25 קילומטרים."), a("רכיבה על אופניים: 5 min, 25.0 km, 600 kcal\nלאשר ולשמור?")],
    draft: { workout: ride(5) },
    message: "55 דקות*",
    check: (o) => [["workout is now 55 min", o.draft.workout?.durationSec === 3300], ["reply mentions 55", /55/.test(o.replyContent)]],
  },
  {
    name: "bike_correction_sentence",
    prior: [u("50 ל-5 דקות שרפתי 600 קלוריות ועשיתי 25 קילומטרים."), a("רכיבה על אופניים: 5 min, 25.0 km, 600 kcal\nלאשר ולשמור?")],
    draft: { workout: ride(5) },
    message: "רכבתי 55 דקות ולא 5",
    check: (o) => [["workout is now 55 min", o.draft.workout?.durationSec === 3300], ["reply mentions 55", /55/.test(o.replyContent)]],
  },
  {
    name: "usual_shake_with_open_ride_draft",
    prior: [u("רכבתי 55 דקות ולא 5"), a("רכיבה על אופניים: 55 min, 25.0 km, 600 kcal\nלאשר ולשמור?")],
    draft: { workout: ride(55) },
    message: "שתיתי את השיק חלבון הרגיל שלי",
    check: (o) => [
      ["drafted the regular shake 128/26", o.draft.meal?.items.some((i) => /שייק/.test(i.description) && Math.round(i.calories) === 128)],
      ["ride still in draft", !!o.draft.workout],
    ],
  },
  {
    name: "complaint_you_are_wrong",
    prior: [
      u("רכבתי 55 דקות ולא 5"),
      a("רכיבה על אופניים: 55 min, 25.0 km, 600 kcal\nלאשר ולשמור?"),
      u("שתיתי את השיק חלבון הרגיל שלי"),
      a("רכיבה על אופניים: 55 min, 25.0 km, 600 kcal\nלאשר ולשמור?"),
    ],
    draft: { workout: ride(55) },
    message: "את טועה, שימי לב מה כתבתי ומה ענית",
    check: (o) => [
      ["flag_mistake called", o.mistakeFlagged],
      ["shake now drafted", !!o.draft.meal?.items.some((i) => /שייק|שיק/.test(i.description))],
      ["reply is not the old reply", !/^רכיבה על אופניים: 55 min/.test(o.replyContent)],
    ],
  },
  {
    name: "workout_not_added_as_food",
    prior: [u("אכלתי 50 גרם סלמון"), a("סלמון: 116 kcal, 13גר חלבון\nלאשר ולשמור?"), u("שתיתי חצי משקה חלבון עם הערכים 20 גרם חלבון 150 קלוריות"), a("חצי משקה חלבון: 150 kcal, 20גר חלבון\nלאשר ולשמור?")],
    draft: { meal: { items: [item("חצי משקה חלבון", 150, 20)], date: TODAY } },
    message: "עשיתי אימון כוח ושרפתי בו 550 קלוריות והוא ערך בערך שעה וחצי",
    check: (o) => [
      ["workout 90 min / 550", o.draft.workout?.durationSec === 5400 && o.draft.workout?.calories === 550],
      ["meal draft not polluted", (o.draft.meal?.items.length ?? 0) <= 1 && !o.draft.meal?.items.some((i) => /אימון/.test(i.description))],
    ],
  },
  {
    name: "only_the_workout",
    draft: { meal: { items: [item("חצי בירה לומה", 108, 1), item("סלמון", 116, 13)], date: TODAY }, workout: { type: "אימון כוח", durationSec: 5400, calories: 550, date: TODAY } },
    prior: [a("אימון כוח 90 דק׳ 550 קל׳, חצי בירה 108, סלמון 116. לאשר?")],
    message: "רק את האימון תוסיף",
    check: (o) => [["meal removed from draft", !o.draft.meal], ["workout kept", !!o.draft.workout]],
  },
  {
    name: "muffin_for_yesterday_with_waiting_draft",
    draft: { meal: { items: [item("חציל עם טחינה", 110, 2)], date: TODAY } },
    prior: [a("חציל עם טחינה: 110 kcal, 2 גר חלבון\nלאשר ולשמור?")],
    message: "תוסיף לאתמול מאפינס 400 קלוריות ו40 גרם חלבון",
    check: (o) => [
      ["no bogus 510 merge", !o.draft.meal?.items.some((i) => Math.round(i.calories) === 510)],
      ["no edit/delete action", !o.draft.mealAction],
      ["muffin proposed for yesterday OR user asked about waiting item", (o.draft.meal?.date === YESTERDAY && o.draft.meal.items.some((i) => Math.round(i.calories) === 400)) || /\?/.test(o.replyContent)],
    ],
  },
  {
    name: "delete_saved_muffin_yesterday",
    state: { meals: [{ date: TODAY, entries: [], totalCalories: 0, totalProtein: 0 }, { date: YESTERDAY, entries: [{ id: "e96d5fd2", name: "מאפינס", calories: 400, protein: 40 }], totalCalories: 400, totalProtein: 40 }] },
    prior: [],
    message: "תמחק את המאפינס מאתמול",
    check: (o) => [["delete proposed for the right entry", o.draft.mealAction?.action === "delete" && o.draft.mealAction.entryId === "e96d5fd2" && o.draft.mealAction.date === YESTERDAY]],
  },
  {
    name: "add_beer_for_yesterday_is_new_log",
    state: { meals: [{ date: YESTERDAY, entries: [{ id: "b1", name: "Half beer", calories: 54, protein: 0 }], totalCalories: 54, totalProtein: 0 }] },
    prior: [],
    message: "תכניס חצי בירה לומה לצריכה של אתמול",
    check: (o) => [["new log for yesterday, not an edit", o.draft.meal?.date === YESTERDAY && !o.draft.mealAction]],
  },
  {
    name: "generic_meal_totals",
    message: "תרשום ארוחה של 600 קלוריות ו-40 גרם חלבון",
    check: (o) => [["generic meal 600/40", o.draft.meal?.items.length === 1 && Math.round(o.draft.meal.items[0].calories) === 600 && Math.round(o.draft.meal.items[0].protein) === 40]],
  },
  {
    name: "named_food_with_values_keeps_name",
    message: "שתיתי חצי משקה חלבון עם הערכים 20 גרם חלבון 150 קלוריות",
    check: (o) => [["name kept", /משקה חלבון/.test(o.draft.meal?.items[0]?.description ?? "")], ["150/20", Math.round(o.draft.meal?.items[0]?.calories) === 150 && Math.round(o.draft.meal?.items[0]?.protein) === 20]],
  },
  {
    name: "reminder_friendly",
    message: "תזכיר לי כל ערב ב20:30 להכניס את הצריכה היומית",
    toolCheck: (o) => o.toolCalls.find((c) => c.name === "manage_reminders"),
    check: (o) => {
      const c = o.toolCalls.find((t) => t.name === "manage_reminders");
      return [["created at 20:30", c?.args.time === "20:30"], ["friendly message (not a verbatim copy)", !!c?.args.message && c.args.message.trim() !== "להכניס את הצריכה היומית" && c.args.message.length > 25]];
    },
  },
  {
    name: "tahini_consistency",
    draft: { meal: { items: [item("חציל עם טחינה", 50, 1)], date: TODAY } },
    prior: [u("חצי חציל עם כף טחינה"), a("חציל עם טחינה: 50 kcal, 1גר חלבון\nלאשר ולשמור?"), u("כמה קלוריות יש בכף טחינה?"), a("בכף טחינה יש בדרך כלל בין 80 ל-90 קלוריות.")],
    message: "אז איך זה תואם את הערכים שנתת לי קודם",
    check: (o) => [["draft corrected upward (>=85)", (o.draft.meal?.items[0]?.calories ?? 0) >= 85], ["reply acknowledges the mismatch", /80|85|90|טעית|לא תואם|לא מדויק|תיקנ|עדכנ|מעודכן/.test(o.replyContent)]],
  },
  {
    name: "unrelated_question_keeps_draft",
    draft: { meal: { items: [item("חציל עם טחינה", 110, 2)], date: TODAY } },
    prior: [a("חציל עם טחינה: 110 kcal, 2 גר חלבון\nלאשר ולשמור?")],
    message: "כמה צעדים כדאי ללכת ביום?",
    check: (o) => [["draft still there", !!o.draft.meal], ["reply mentions the waiting item", /חציל|ממתין|מחכה|לאשר/.test(o.replyContent)]],
  },
  {
    name: "fact_fixes_draft_immediately",
    draft: { meal: { items: [item("שייק חלבון", 153, 17)], date: TODAY } },
    prior: [u("שתיתי את השייק הרגיל שלי הבוקר"), a("שייק חלבון: 153 kcal, 17 גרם חלבון\nלאשר ולשמור?")],
    message: "הערך שכמעט תמיד חוזר על עצמו עבור שייק חלבון הוא 128 קלוריות ו26 גרם חלבון",
    check: (o) => [
      ["draft updated to 128/26", Math.round(o.draft.meal?.items[0]?.calories) === 128 && Math.round(o.draft.meal?.items[0]?.protein) === 26],
      ["remembered the fact", o.toolCalls.some((t) => t.name === "remember")],
    ],
  },
  {
    name: "delete_saved_workout",
    state: { workouts: [{ id: "w1", date: TODAY, type: "רכיבה על אופניים", durationMin: 5, distanceKm: 25, calories: 600 }] },
    message: "תמחק את הרכיבה של 5 דקות מהיום",
    check: (o) => [["workout delete proposed", o.draft.actions?.some((x) => x.type === "workout_delete" && x.id === "w1")]],
  },
  {
    name: "edit_saved_workout",
    state: { workouts: [{ id: "w1", date: TODAY, type: "רכיבה על אופניים", durationMin: 5, distanceKm: 25, calories: 600 }] },
    message: "תתקן את הרכיבה של היום ל-55 דקות",
    check: (o) => [["workout update proposed 55 min", o.draft.actions?.some((x) => x.type === "workout_update" && x.id === "w1" && x.changes.duration === 3300)]],
  },
  {
    name: "quick_balance",
    state: { calorieGoal: 2000, proteinGoal: 160, workouts: [], meals: [{ date: TODAY, entries: [{ id: "m1", name: "ארוחה", calories: 1500, protein: 100 }], totalCalories: 1500, totalProtein: 100 }] },
    message: "מה המאזן שלי היום?",
    check: (o) => [
      ["says 500 calories left", /500/.test(o.replyContent)],
      ["says 60g protein to go", /60/.test(o.replyContent)],
      ["short answer", o.replyContent.length < 320],
    ],
  },
  {
    name: "delete_steps_yesterday",
    message: "תמחק את הצעדים של אתמול",
    check: (o) => [["steps delete proposed for yesterday", o.draft.actions?.some((x) => x.type === "steps_delete" && x.date === YESTERDAY)]],
  },
  {
    name: "change_protein_goal",
    message: "תעלה את יעד החלבון שלי ל-150",
    check: (o) => [["profile_update proteinGoal=150", o.draft.actions?.some((x) => x.type === "profile_update" && x.changes.proteinGoal === 150)]],
  },
  {
    name: "tick_custom_goal",
    state: { profile: { calorieGoal: 2000, proteinGoal: 140, language: "he", customGoals: [{ id: "g1", name: "שתיית מים", type: "numeric", unit: "כוסות", target: 8 }] } },
    message: "שתיתי 8 כוסות מים היום",
    check: (o) => [["set_daily_goal called with 8", o.toolCalls.some((t) => t.name === "set_daily_goal" && t.args.value === 8)]],
  },
  {
    name: "builtin_reminder_toggle",
    state: { profile: { calorieGoal: 2000, proteinGoal: 140, language: "he", whatsappPhone: "972500000000" } },
    message: "תפעילי לי סיכום ערב ב-21:30",
    check: (o) => [["set_builtin_reminder eveningSummary 21:30", o.toolCalls.some((t) => t.name === "set_builtin_reminder" && t.args.type === "eveningSummary" && t.args.time === "21:30" && t.args.enabled === true)]],
  },
  {
    name: "ask_about_my_goals",
    message: "מה היעדים שלי?",
    check: (o) => [["answers with goal numbers", /\d{3,}/.test(o.replyContent)]],
  },
];

const only = process.argv[2] && process.argv[2] !== "all" ? process.argv[2] : null;
const runs = Number(process.argv[3] ?? 2);
let failed = 0;
for (const c of cases.filter((c) => !only || c.name === only)) {
  for (let r = 0; r < runs; r++) {
    const res = await fetch(`${BASE}/api/dev/agent-eval`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-eval-secret": "local-eval" },
      body: JSON.stringify({ uid: UID, today: TODAY, nowIso: NOW, userMessage: c.message, priorMessages: c.prior ?? [], draft: c.draft ?? {}, stateOverride: { workouts: [], meals: [], stepsToday: undefined, ...(c.state ?? {}) } }),
    });
    const o = await res.json();
    if (!res.ok) { console.log(`✗ ${c.name} #${r + 1}: HTTP ${res.status} ${JSON.stringify(o).slice(0, 200)}`); failed++; continue; }
    const results = c.check(o);
    const bad = results.filter(([, ok]) => !ok);
    console.log(`${bad.length ? "✗" : "✓"} ${c.name} #${r + 1}${bad.length ? "  FAILED: " + bad.map(([n]) => n).join("; ") : ""}`);
    console.log(`    tools: ${o.toolCalls.map((t) => t.name).join(", ") || "-"}\n    reply: ${o.replyContent.replace(/\n/g, " ⏎ ")}`);
    if (bad.length) failed++;
  }
}
console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
