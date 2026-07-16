"use client";

/**
 * Placeholder — full History screen (7-day calendar strip, day detail
 * drawer, 7/30-day charts) is a later phase. Exists now so the nav tab has
 * somewhere to go instead of a dead link.
 */
import { useI18n } from "@/lib/i18n/useI18n";

export default function History() {
  const { t } = useI18n();
  return (
    <main>
      <h1>{t("navHistory")}</h1>
      <div className="card" style={{ marginTop: 16 }}>
        <p style={{ color: "var(--muted)", margin: 0 }}>Coming in a later update.</p>
      </div>
    </main>
  );
}
