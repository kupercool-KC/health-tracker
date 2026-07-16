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
  time: { en: "Time", he: "שעה" },
  meal: { en: "Meal", he: "ארוחה" },
  total: { en: "Total", he: "סה\"כ" },

  workouts: { en: "Workouts", he: "אימונים" },
  lastSynced: { en: "Last synced", he: "סונכרן לאחרונה" },
  refresh: { en: "Refresh", he: "רענן" },

  loading: { en: "Loading…", he: "טוען…" },
  signInPrompt: { en: "Sign in to log nutrition and view your data.", he: "התחבר כדי לרשום תזונה ולראות את הנתונים שלך." },
  signInWithGoogle: { en: "Sign in with Google", he: "התחברות עם Google" },
  signOut: { en: "Sign out", he: "התנתקות" },
} as const;

export type StringKey = keyof typeof strings;
export type Language = "en" | "he";
