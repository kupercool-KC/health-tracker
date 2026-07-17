/**
 * One key, two values. Keep this flat — nested keys make the EN/HE diff
 * harder to eyeball when adding a string.
 */
export const strings = {
  appName: { en: "Health Tracker", he: "טרקר בריאות" },

  navToday: { en: "Today", he: "היום" },
  navHistory: { en: "History", he: "היסטוריה" },
  navProfile: { en: "Profile", he: "פרופיל" },

  today: { en: "Today", he: "היום" },
  calories: { en: "Calories", he: "קלוריות" },
  protein: { en: "Protein", he: "חלבון" },
  burned: { en: "Burned", he: "נשרף" },
  net: { en: "Net", he: "נטו" },
  consumed: { en: "consumed", he: "נאכל" },
  goal: { en: "goal", he: "מטרה" },
  remaining: { en: "remaining", he: "נותר" },
  surplus: { en: "surplus", he: "עודף" },
  deficit: { en: "deficit", he: "חוסר" },

  meals: { en: "Meals", he: "ארוחות" },
  addMeal: { en: "+ Add meal", he: "+ הוסף ארוחה" },
  addMealPlaceholder: { en: "e.g. two eggs and a slice of toast", he: "לדוגמה: שתי ביצים וטוסט" },
  chooseFile: { en: "Choose File", he: "בחר קובץ" },
  logIt: { en: "Log it", he: "שמור" },
  logging: { en: "Logging…", he: "שומר…" },
  time: { en: "Time", he: "שעה" },
  meal: { en: "Meal", he: "ארוחה" },
  total: { en: "Total", he: "סה\"כ" },
  carbs: { en: "carbs", he: "פחמימות" },
  fat: { en: "fat", he: "שומן" },
  fiber: { en: "fiber", he: "סיבים" },
  confidence: { en: "confidence", he: "רמת ביטחון" },

  workouts: { en: "Workouts", he: "אימונים" },
  lastSynced: { en: "Last synced", he: "סונכרן לאחרונה" },
  refresh: { en: "Refresh", he: "רענן" },
  noWorkoutsToday: { en: "—", he: "—" },

  loading: { en: "Loading…", he: "טוען…" },
  signInPrompt: { en: "Sign in to log nutrition and view your data.", he: "התחבר כדי לרשום תזונה ולראות את הנתונים שלך." },
  signInWithGoogle: { en: "Sign in with Google", he: "התחברות עם Google" },
  signOut: { en: "Sign out", he: "התנתקות" },

  appleHealthSyncTitle: { en: "Apple Health sync", he: "סנכרון Apple Health" },
  appleHealthSyncDesc: {
    en: "Generate a personal token to paste into your Health Auto Export automation. Generating a new one immediately revokes the previous one.",
    he: "צור טוקן אישי להדבקה באוטומציה של Health Auto Export. יצירת טוקן חדש מבטלת מיידית את הקודם.",
  },
  generateNewToken: { en: "Generate new token", he: "צור טוקן חדש" },
  working: { en: "Working…", he: "מעבד…" },
  revoke: { en: "Revoke", he: "בטל" },
  copy: { en: "Copy", he: "העתק" },
  copied: { en: "Copied!", he: "הועתק!" },
  copyNote: { en: "Copy this now — it won't be shown again.", he: "העתק כעת — הטוקן לא יוצג שוב." },
  adminSettings: { en: "Admin settings", he: "הגדרות מנהל" },
  comingLater: {
    en: "Dietary profile, alerts, memory, and goals sections are coming in a later update.",
    he: "מקטעי תזונה, התראות, זיכרון ומטרות יגיעו בעדכון עתידי.",
  },

  goalsTitle: { en: "Goals", he: "מטרות" },
  calorieGoalLabel: { en: "Daily calorie goal", he: "מטרת קלוריות יומית" },
  proteinGoalLabel: { en: "Daily protein goal (g)", he: "מטרת חלבון יומית (גרם)" },
  saveGoals: { en: "Save", he: "שמור" },
  saved: { en: "Saved.", he: "נשמר." },
} as const;

export type StringKey = keyof typeof strings;
export type Language = "en" | "he";
