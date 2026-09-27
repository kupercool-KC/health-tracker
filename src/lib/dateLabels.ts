export function dayLabel(date: string): string {
  return `${date.slice(5, 7)}/${date.slice(8, 10)}`;
}

/** Localized short weekday name (e.g. "Mon" / "ב׳") — Intl handles both locales without a lookup table. */
export function weekdayLabel(date: string, lang: "en" | "he"): string {
  return new Intl.DateTimeFormat(lang, { weekday: "short" }).format(new Date(`${date}T00:00:00`));
}
