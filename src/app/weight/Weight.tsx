"use client";

/**
 * Weight screen: dedicated home for weekly weigh-ins, separate from History
 * (which is about daily calories/protein/steps). Logging itself happens
 * through the same global chat FAB (NavShell renders it on every page) —
 * this screen is just the graphs, moved here from History.
 */
import AppleSignInButton from "@/app/AppleSignInButton";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/firebase/useAuth";
import { useI18n } from "@/lib/i18n/useI18n";
import { getBodyMetricsSince, localDateKeyDaysAgo } from "@/lib/dashboard/queries";
import { dayLabel, weekdayLabel } from "@/lib/dateLabels";
import type { BodyMetricsEntry } from "@/lib/types";

/**
 * A single body-metric's readings over time — a line chart rather than
 * bars, since weigh-ins are sparse (weekly, by design) rather than one
 * value per day; points are evenly spaced by index instead of literally
 * date-proportional, which reads fine at a roughly-weekly cadence and
 * keeps this simple.
 */
function WeighInLineChart({
  points,
  label,
  identityColorVar,
  unit,
}: {
  points: { date: string; value: number }[];
  label: string;
  identityColorVar: string;
  unit: string;
}) {
  const { lang } = useI18n();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const height = 90;
  const values = points.map((p) => p.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  // A flat/near-flat series would otherwise divide by ~0 — pad the range so the line isn't pinned to an edge.
  const pad = Math.max((rawMax - rawMin) * 0.15, rawMax * 0.02, 1);
  const min = rawMin - pad;
  const max = rawMax + pad;
  const stepX = points.length > 1 ? 100 / (points.length - 1) : 0;
  const yOf = (v: number) => height - ((v - min) / (max - min)) * height;
  const linePoints = points.map((p, i) => `${i * stepX},${yOf(p.value)}`).join(" ");

  return (
    <div className="card" style={{ marginTop: 12, position: "relative" }}>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
        <span style={{ color: identityColorVar }}>■</span> {label}
      </div>
      <div style={{ display: "flex" }}>
        <div style={{ position: "relative", width: 34, height, flexShrink: 0 }}>
          <bdi dir="ltr" style={{ position: "absolute", top: 0, insetInlineEnd: 4, fontSize: 10, color: "var(--muted)" }}>
            {Math.round(max * 10) / 10}
          </bdi>
          <bdi
            dir="ltr"
            style={{ position: "absolute", bottom: 0, insetInlineEnd: 4, fontSize: 10, color: "var(--muted)" }}
          >
            {Math.round(min * 10) / 10}
          </bdi>
        </div>
        <svg
          viewBox={`0 0 100 ${height}`}
          preserveAspectRatio="none"
          style={{ width: "100%", height }}
          onMouseLeave={() => setHoverIdx(null)}
        >
          <polyline points={linePoints} fill="none" stroke={identityColorVar} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          {points.map((p, i) => (
            <circle
              key={p.date}
              cx={i * stepX}
              cy={yOf(p.value)}
              r={hoverIdx === i ? 3 : 2}
              fill={identityColorVar}
              onMouseEnter={() => setHoverIdx(i)}
              onClick={() => setHoverIdx(i)}
              style={{ cursor: "pointer" }}
            />
          ))}
        </svg>
      </div>
      {hoverIdx != null && points[hoverIdx] && (
        <div
          style={{
            position: "absolute",
            top: 8,
            insetInlineEnd: 8,
            background: "var(--bg-muted)",
            border: "0.5px solid var(--border)",
            borderRadius: 8,
            padding: "6px 10px",
            fontSize: 12,
          }}
        >
          <bdi dir="ltr">{dayLabel(points[hoverIdx].date)}</bdi> {weekdayLabel(points[hoverIdx].date, lang)} ·{" "}
          <bdi dir="ltr">
            {points[hoverIdx].value}
            {unit}
          </bdi>
        </div>
      )}
    </div>
  );
}

const BODY_METRIC_FIELDS = [
  { key: "weightKg", labelKey: "weightLabel", color: "var(--calories)", unit: "" },
  { key: "bmi", labelKey: null, label: "BMI", color: "var(--protein)", unit: "" },
  { key: "muscleMassKg", labelKey: "muscleMassLabel", color: "var(--burned)", unit: "" },
  { key: "bodyFatPercent", labelKey: "bodyFatLabel", color: "var(--net)", unit: "%" },
  { key: "visceralFat", labelKey: "visceralFatLabel", color: "var(--calories)", unit: "" },
  { key: "bodyWaterPercent", labelKey: "bodyWaterLabel", color: "var(--protein)", unit: "%" },
  { key: "basalMetabolicRate", labelKey: "bmrLabel", color: "var(--burned)", unit: " kcal" },
  { key: "proteinPercent", labelKey: "proteinPercentLabel", color: "var(--net)", unit: "%" },
] as const;

export default function Weight({ embedded = false }: { embedded?: boolean } = {}) {
  const { user, loading: authLoading, authError, signIn } = useAuth();
  const { t } = useI18n();
  const [entries, setEntries] = useState<BodyMetricsEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    getBodyMetricsSince(user.uid, localDateKeyDaysAgo(365))
      .then(setEntries)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [user]);

  if (authLoading) {
    return (
      <main>
        <p style={{ color: "var(--muted)" }}>{t("loading")}</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main>
        <h1>{t("navWeight")}</h1>
        <p style={{ color: "var(--muted)" }}>{t("signInPrompt")}</p>
        <button onClick={() => signIn()}>{t("signInWithGoogle")}</button>
        <AppleSignInButton />
        {authError && <p style={{ color: "#ff6b6b", fontSize: 13 }}>{t("signInFailed")}: {authError}</p>}
      </main>
    );
  }

  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  const charts = BODY_METRIC_FIELDS.map((field) => {
    const points = sorted.filter((e) => e[field.key] != null).map((e) => ({ date: e.date, value: e[field.key] as number }));
    return { field, points };
  }).filter((c) => c.points.length > 0);

  const Shell = embedded ? "div" : "main";
  return (
    <Shell>
      {!embedded && <h1>{t("navWeight")}</h1>}
      <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 4 }}>{t("weighInHint")}</p>

      {loading ? (
        <p style={{ color: "var(--muted)" }}>{t("loading")}</p>
      ) : charts.length === 0 ? (
        <div className="card" style={{ marginTop: 16 }}>
          <p style={{ color: "var(--muted)", margin: 0 }}>{t("weighInNoEntries")}</p>
        </div>
      ) : (
        <div style={{ marginTop: 16 }}>
          <p style={{ color: "var(--muted)", fontSize: 12, margin: "0 0 4px" }}>{t("weighInOpenChatHint")}</p>
          {charts.map(({ field, points }) => (
            <WeighInLineChart
              key={field.key}
              points={points}
              label={field.labelKey ? t(field.labelKey) : field.label!}
              identityColorVar={field.color}
              unit={field.unit}
            />
          ))}
        </div>
      )}
    </Shell>
  );
}
