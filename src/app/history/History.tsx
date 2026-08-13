"use client";

/**
 * History screen: 7-day calendar strip (goal-status color dots), tap a day
 * for a full breakdown drawer, and a weekly/monthly/custom-range period
 * picker driving three charts — calories, protein (bars turn red on days
 * the protein goal was missed), and an aggregate day-by-day standing view.
 * Charts are hand-rolled inline SVG rather than a charting library — simple
 * gradient-filled bars, no new dependency needed for this.
 */
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/firebase/useAuth";
import { useI18n } from "@/lib/i18n/useI18n";
import {
  getMealDaysSince,
  getStepsSince,
  getWorkoutsSince,
  localDateKey,
  localDateKeyDaysAgo,
} from "@/lib/dashboard/queries";
import { getUserGoals } from "@/lib/profile/queries";
import { computeNetCalories } from "@/lib/goals/netCalories";
import type { MealDay, UserProfile, Workout } from "@/lib/types";

interface DayInfo {
  date: string;
  calories: number;
  protein: number;
  burned: number;
  /** calories − (burned × the profile's net-calorie-burn factor) — see src/lib/goals/netCalories.ts. */
  netCalories: number;
  steps: number;
  workoutCount: number;
  /** meters */
  distance: number;
  hasData: boolean;
  entries: MealDay["entries"];
  workouts: Workout[];
  /** 0-100 combined adherence score (see `adherence` below) — average of the calorie and protein scores for the day. */
  overallScore: number;
}

type Period = "weekly" | "monthly" | "custom";

/** Bounded — a personal app doesn't need to ever fetch more than this in one go. */
const MAX_FETCH_DAYS = 366;

function dayLabel(date: string): string {
  return `${date.slice(5, 7)}/${date.slice(8, 10)}`;
}

/** dd-mm-yyyy — matches the app's day/month-first convention, unlike the underlying yyyy-mm-dd storage key. */
function fullDateLabel(date: string): string {
  return `${date.slice(8, 10)}-${date.slice(5, 7)}-${date.slice(0, 4)}`;
}

/** Localized short weekday name (e.g. "Mon" / "ב׳") — Intl handles both locales without a lookup table. */
function weekdayLabel(date: string, lang: "en" | "he"): string {
  return new Intl.DateTimeFormat(lang, { weekday: "short" }).format(new Date(`${date}T00:00:00`));
}

/** "d.m" (day.month, no leading zeros) — e.g. "12.9" for September 12th. */
function dotDateLabel(date: string): string {
  return `${Number(date.slice(8, 10))}.${Number(date.slice(5, 7))}`;
}

/** Average steps per kilometer, from a typical ~0.77m stride — used only to estimate a rough walking distance from step count when no GPS-tracked workout distance is logged for the day. */
const AVERAGE_STEPS_PER_KM = 1300;

/**
 * Always-visible x-axis under a bar chart — date (dot format) over weekday
 * abbreviation, per bar. With more than a handful of bars every label would
 * overlap into an unreadable smear, so only an evenly-spaced subset is
 * actually rendered (empty slots keep their width for alignment with the
 * bars above). Matches MetricBarChart/SimpleBarChart's own layout: a fixed
 * 34px gutter (mirroring their y-axis label column) then one equal-width
 * slot per day.
 */
function ChartXAxis({ days, lang }: { days: { date: string }[]; lang: "en" | "he" }) {
  const MAX_LABELS = 8;
  const step = Math.max(1, Math.ceil(days.length / MAX_LABELS));
  return (
    <div style={{ display: "flex", marginTop: 4 }}>
      <div style={{ width: 34, flexShrink: 0 }} />
      <div style={{ display: "flex", width: "100%" }}>
        {days.map((d, i) => (
          <div key={d.date} style={{ flex: 1, textAlign: "center", fontSize: 9, color: "var(--muted)", lineHeight: 1.35 }}>
            {i % step === 0 && (
              <>
                <bdi dir="ltr" style={{ display: "block" }}>
                  {dotDateLabel(d.date)}
                </bdi>
                <span style={{ display: "block" }}>{weekdayLabel(d.date, lang)}</span>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatPaceSecPerKm(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}/km`;
}

/**
 * 0-100 "how well did this day meet the goal" score for one metric.
 * "atMost" (calories): 100 at/under goal, falling off past it.
 * "atLeast" (protein): scales up to 100 as it approaches/reaches goal, capped there.
 */
function adherence(value: number, goal: number, direction: "atMost" | "atLeast"): number {
  if (goal <= 0) return 100;
  if (direction === "atMost") {
    return value <= goal ? 100 : Math.max(0, 100 - ((value - goal) / goal) * 100);
  }
  return Math.min(100, (value / goal) * 100);
}

/**
 * How far under the goal a missed-goal bar is, in four severity tiers
 * (most-severe first) — used to shade a missed bar red→orange→amber instead
 * of a flat red, so "almost hit the goal" reads differently from "barely
 * moved." Not used for goals where missing by a little vs. a lot isn't the
 * point (e.g. calories, where any overage is the same kind of "bad").
 */
function severityTierColor(ratio: number): { color: string; light: string } {
  if (ratio < 0.25) return { color: "#b91c1c", light: "#f87171" }; // deep red
  if (ratio < 0.5) return { color: "#dc2626", light: "#fca5a5" }; // red
  if (ratio < 0.75) return { color: "#f97316", light: "#fdba74" }; // orange
  return { color: "#eab308", light: "#fde68a" }; // amber — closest to the goal
}

/** Shared gradient-filled bar chart for a single metric, with hover/tap tooltip. */
function MetricBarChart({
  days,
  valueKey,
  goal,
  label,
  identityColorVar,
  badColorVar,
  badColorLightVar,
  /** "atMost": under/at goal is good (calories). "atLeast": at/over goal is good (protein). */
  goalDirection,
  goodLabel,
  badLabel,
  unit,
  goalLabel,
  /** Fixed y-axis gridline spacing (e.g. 500 for calories, 50 for protein/overall) — a dynamic step made the axis jump around as the visible range changed. */
  yStep,
  onSelectDay,
  /** When set, the goal line/comparison varies per day instead of being flat — used for the calories chart's net-adjusted boundary (goal + burned×factor%), so a workout day's bar can go green even above the raw goal. */
  perDayGoal,
  /** When true, a missed-goal bar is shaded by how far under the goal it fell (four tiers, red→amber) instead of a flat bad color — see severityTierColor. Only meaningful for "atLeast" goals. */
  severityWhenBad,
}: {
  days: DayInfo[];
  valueKey: "calories" | "protein" | "overallScore" | "steps";
  goal: number;
  label: string;
  /** Used only for the goal line + legend square — identifies which chart this is, not day-by-day status. */
  identityColorVar: string;
  badColorVar: string;
  badColorLightVar: string;
  goalDirection: "atMost" | "atLeast";
  goodLabel: string;
  badLabel: string;
  unit: string;
  /** Node shown next to the dashed goal reference line, e.g. "Goal: 1950 kcal". */
  goalLabel: React.ReactNode;
  yStep: number;
  /** Opens the day-detail drawer for the clicked bar's date. */
  onSelectDay: (date: string) => void;
  perDayGoal?: (d: DayInfo) => number;
  severityWhenBad?: boolean;
}) {
  const { t, lang } = useI18n();
  // Hebrew graphs read as cluttered with "גר" glued to every protein number
  // (e.g. "214גר") — dropped there specifically; English keeps "g".
  const gramsUnit = lang === "he" ? "" : t("unitG");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const height = 140;
  const goalFor = (d: DayInfo) => perDayGoal?.(d) ?? goal;
  const maxGoal = perDayGoal ? Math.max(goal, ...days.map(goalFor)) : goal;
  const rawMax = Math.max(maxGoal, ...days.map((d) => d[valueKey]), 1) * 1.15;
  const max = Math.max(Math.ceil(rawMax / yStep) * yStep, yStep);
  const barWidth = 100 / Math.max(days.length, 1);
  const gradGoodId = `grad-${valueKey}-good`;
  const gradBadId = `grad-${valueKey}-bad`;
  const tickCount = max / yStep;
  const yTicks = Array.from({ length: tickCount + 1 }, (_, i) => ({
    y: height - (i / tickCount) * height,
    value: i * yStep,
  }));
  // Step polyline through each day's goal line — a flat `goal` for every day
  // produces a plain horizontal line; `perDayGoal` makes it jump per day.
  const goalLinePoints = days
    .flatMap((d, i) => {
      const y = height - (goalFor(d) / max) * height;
      return [`${i * barWidth},${y}`, `${(i + 1) * barWidth},${y}`];
    })
    .join(" ");

  return (
    <div className="card" style={{ marginTop: 16, position: "relative" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
        <div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>
            <span style={{ color: identityColorVar }}>■</span> {label}
          </div>
          <div style={{ fontSize: 11, color: identityColorVar, opacity: 0.85, marginTop: 2 }}>
            <span aria-hidden style={{ display: "inline-block", width: 10, borderTop: `1.5px dashed ${identityColorVar}`, marginInlineEnd: 4, verticalAlign: "middle" }} />
            {goalLabel}
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, fontSize: 11, color: "var(--muted)" }}>
          <span>
            <span style={{ color: "var(--burned)" }}>■</span> {goodLabel}
          </span>
          <span>
            <span style={{ color: badColorVar }}>■</span> {badLabel}
          </span>
        </div>
      </div>
      <div style={{ display: "flex" }}>
        {/* Y-axis: plain HTML, not SVG — the chart's viewBox is stretched
            non-uniformly (preserveAspectRatio="none") so SVG <text> inside it
            would render horizontally distorted; positioning labels outside
            at the same pixel offsets avoids that. */}
        <div style={{ position: "relative", width: 34, height, flexShrink: 0 }}>
          {yTicks.map((tick) => (
            <bdi
              dir="ltr"
              key={tick.y}
              style={{
                position: "absolute",
                top: tick.y,
                insetInlineEnd: 4,
                transform: "translateY(-50%)",
                fontSize: 10,
                color: "var(--muted)",
              }}
            >
              {tick.value}
            </bdi>
          ))}
        </div>
        <svg
          viewBox={`0 0 100 ${height}`}
          preserveAspectRatio="none"
          style={{ width: "100%", height }}
          onMouseLeave={() => setHoverIdx(null)}
        >
          <defs>
            {/* Good = green, always — this is a status color, not a per-chart identity color. */}
            <linearGradient id={gradGoodId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--burned-light)" />
              <stop offset="100%" stopColor="var(--burned)" />
            </linearGradient>
            <linearGradient id={gradBadId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={badColorLightVar} />
              <stop offset="100%" stopColor={badColorVar} />
            </linearGradient>
            {severityWhenBad &&
              days.map((d, i) => {
                const dayGoal = goalFor(d);
                const bad = d.hasData && d[valueKey] < dayGoal;
                if (!bad) return null;
                const tier = severityTierColor(dayGoal > 0 ? d[valueKey] / dayGoal : 0);
                return (
                  <linearGradient key={d.date} id={`grad-${valueKey}-sev-${i}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={tier.light} />
                    <stop offset="100%" stopColor={tier.color} />
                  </linearGradient>
                );
              })}
          </defs>
          {yTicks.map((tick) => (
            <line key={tick.y} x1={0} y1={tick.y} x2={100} y2={tick.y} stroke="var(--border)" strokeWidth={0.5} />
          ))}
          <polyline points={goalLinePoints} fill="none" stroke={identityColorVar} strokeDasharray="2,2" strokeWidth={0.5} />
          {days.map((d, i) => {
            const val = d[valueKey];
            const barHeight = Math.max((val / max) * height, val > 0 ? 1 : 0);
            const x = i * barWidth;
            const dayGoal = goalFor(d);
            const bad = d.hasData && (goalDirection === "atMost" ? val > dayGoal : val < dayGoal);
            const fillId = bad ? (severityWhenBad ? `grad-${valueKey}-sev-${i}` : gradBadId) : gradGoodId;
            return (
              <rect
                key={d.date}
                x={x + barWidth * 0.15}
                y={height - barHeight}
                width={barWidth * 0.7}
                height={barHeight}
                fill={`url(#${fillId})`}
                opacity={hoverIdx === null || hoverIdx === i ? 0.95 : 0.45}
                onMouseEnter={() => setHoverIdx(i)}
                onClick={() => {
                  setHoverIdx(i);
                  onSelectDay(d.date);
                }}
                style={{ cursor: "pointer" }}
              />
            );
          })}
        </svg>
      </div>
      <ChartXAxis days={days} lang={lang} />
      {hoverIdx != null && days[hoverIdx] && (
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
          <bdi dir="ltr">{dayLabel(days[hoverIdx].date)}</bdi> {weekdayLabel(days[hoverIdx].date, lang)} ·{" "}
          <bdi dir="ltr">
            {Math.round(days[hoverIdx][valueKey])}
            {unit}
          </bdi>
          <div style={{ color: "var(--muted)", marginTop: 2 }}>
            <bdi dir="ltr">{Math.round(days[hoverIdx].calories)}</bdi> {t("calories")} ·{" "}
            <bdi dir="ltr">
              {Math.round(days[hoverIdx].protein)}
              {gramsUnit}
            </bdi>{" "}
            {t("protein")}
          </div>
          {perDayGoal && (
            <div style={{ color: "var(--net)", marginTop: 2 }}>
              {t("net")}:{" "}
              <bdi dir="ltr">{Math.round(days[hoverIdx].netCalories)} kcal</bdi>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Single-color bar chart for metrics with no pass/fail goal (workout count,
 * distance, calories burned) — MetricBarChart's whole point is the
 * good/bad goal coloring, which doesn't apply here, so this is a plainer
 * sibling rather than forcing a fake goal onto it.
 */
function SimpleBarChart({
  days,
  valueOf,
  label,
  identityColorVar,
  unit,
  yStep,
  secondValueOf,
  secondLabel,
  secondColorVar,
}: {
  days: DayInfo[];
  valueOf: (d: DayInfo) => number;
  label: string;
  identityColorVar: string;
  unit: string;
  yStep: number;
  /** Optional second series, e.g. steps-estimated distance alongside GPS-tracked workout distance — rendered as a narrower bar next to the first, sharing the same y-axis/scale. */
  secondValueOf?: (d: DayInfo) => number;
  secondLabel?: string;
  secondColorVar?: string;
}) {
  const { lang } = useI18n();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const height = 100;
  const rawMax = Math.max(...days.map(valueOf), ...(secondValueOf ? days.map(secondValueOf) : []), 1) * 1.15;
  const max = Math.max(Math.ceil(rawMax / yStep) * yStep, yStep);
  const barWidth = 100 / Math.max(days.length, 1);
  const gradId = `grad-simple-${label.replace(/\s+/g, "-")}`;
  const gradId2 = `grad-simple-2-${label.replace(/\s+/g, "-")}`;
  const tickCount = max / yStep;
  const yTicks = Array.from({ length: tickCount + 1 }, (_, i) => ({
    y: height - (i / tickCount) * height,
    value: i * yStep,
  }));

  return (
    <div className="card" style={{ marginTop: 16, position: "relative" }}>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8, display: "flex", gap: 10 }}>
        <span>
          <span style={{ color: identityColorVar }}>■</span> {label}
        </span>
        {secondValueOf && secondLabel && (
          <span>
            <span style={{ color: secondColorVar }}>■</span> {secondLabel}
          </span>
        )}
      </div>
      <div style={{ display: "flex" }}>
        <div style={{ position: "relative", width: 34, height, flexShrink: 0 }}>
          {yTicks.map((tick) => (
            <bdi
              dir="ltr"
              key={tick.y}
              style={{
                position: "absolute",
                top: tick.y,
                insetInlineEnd: 4,
                transform: "translateY(-50%)",
                fontSize: 10,
                color: "var(--muted)",
              }}
            >
              {tick.value}
            </bdi>
          ))}
        </div>
        <svg
          viewBox={`0 0 100 ${height}`}
          preserveAspectRatio="none"
          style={{ width: "100%", height }}
          onMouseLeave={() => setHoverIdx(null)}
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={`${identityColorVar}`} stopOpacity={0.55} />
              <stop offset="100%" stopColor={identityColorVar} />
            </linearGradient>
            {secondValueOf && (
              <linearGradient id={gradId2} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={`${secondColorVar}`} stopOpacity={0.55} />
                <stop offset="100%" stopColor={secondColorVar} />
              </linearGradient>
            )}
          </defs>
          {yTicks.map((tick) => (
            <line key={tick.y} x1={0} y1={tick.y} x2={100} y2={tick.y} stroke="var(--border)" strokeWidth={0.5} />
          ))}
          {days.map((d, i) => {
            const val = valueOf(d);
            const barHeight = Math.max((val / max) * height, val > 0 ? 1 : 0);
            const x = i * barWidth;
            const w = secondValueOf ? barWidth * 0.32 : barWidth * 0.7;
            return (
              <rect
                key={d.date}
                x={x + (secondValueOf ? barWidth * 0.12 : barWidth * 0.15)}
                y={height - barHeight}
                width={w}
                height={barHeight}
                fill={`url(#${gradId})`}
                opacity={hoverIdx === null || hoverIdx === i ? 0.95 : 0.45}
                onMouseEnter={() => setHoverIdx(i)}
                onClick={() => setHoverIdx(i)}
                style={{ cursor: "pointer" }}
              />
            );
          })}
          {secondValueOf &&
            days.map((d, i) => {
              const val = secondValueOf(d);
              const barHeight = Math.max((val / max) * height, val > 0 ? 1 : 0);
              const x = i * barWidth;
              const w = barWidth * 0.32;
              return (
                <rect
                  key={`second-${d.date}`}
                  x={x + barWidth * 0.52}
                  y={height - barHeight}
                  width={w}
                  height={barHeight}
                  fill={`url(#${gradId2})`}
                  opacity={hoverIdx === null || hoverIdx === i ? 0.95 : 0.45}
                  onMouseEnter={() => setHoverIdx(i)}
                  onClick={() => setHoverIdx(i)}
                  style={{ cursor: "pointer" }}
                />
              );
            })}
        </svg>
      </div>
      <ChartXAxis days={days} lang={lang} />
      {hoverIdx != null && days[hoverIdx] && (
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
          <bdi dir="ltr">{dayLabel(days[hoverIdx].date)}</bdi> {weekdayLabel(days[hoverIdx].date, lang)} ·{" "}
          <bdi dir="ltr">
            {Math.round(valueOf(days[hoverIdx]) * 10) / 10}
            {unit}
          </bdi>
          {secondValueOf && secondLabel && (
            <div style={{ color: secondColorVar, marginTop: 2 }}>
              {secondLabel}:{" "}
              <bdi dir="ltr">
                {Math.round(secondValueOf(days[hoverIdx]) * 10) / 10}
                {unit}
              </bdi>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function History() {
  const { user, loading: authLoading, authError, signIn } = useAuth();
  const { t, lang } = useI18n();
  // Hebrew graphs read as cluttered with "גר" glued to every protein number
  // (e.g. "214גר") — dropped there specifically; English keeps "g".
  const gramsUnit = lang === "he" ? "" : t("unitG");

  const [days, setDays] = useState<DayInfo[]>([]);
  const [goals, setGoals] = useState<
    Pick<UserProfile, "calorieGoal" | "proteinGoal" | "netCalorieBurnFactor" | "stepGoal">
  >({
    calorieGoal: 1950,
    proteinGoal: 145,
    netCalorieBurnFactor: 50,
    stepGoal: 10000,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>("weekly");
  const [customFrom, setCustomFrom] = useState(localDateKeyDaysAgo(6));
  const [customTo, setCustomTo] = useState(localDateKey());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const range = useMemo(() => {
    if (period === "weekly") return { from: localDateKeyDaysAgo(6), to: localDateKey() };
    if (period === "monthly") return { from: localDateKeyDaysAgo(29), to: localDateKey() };
    return { from: customFrom, to: customTo };
  }, [period, customFrom, customTo]);

  useEffect(() => {
    if (!user) return;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [mealDays, workouts, stepsDays, g] = await Promise.all([
          getMealDaysSince(user.uid, range.from, range.to),
          getWorkoutsSince(user.uid, range.from, range.to),
          getStepsSince(user.uid, range.from, range.to),
          getUserGoals(user.uid),
        ]);
        setGoals(g);

        const mealByDate = new Map(mealDays.map((m) => [m.date, m]));
        const stepsByDate = new Map(stepsDays.map((s) => [s.date, s.steps]));
        const workoutsByDate = new Map<string, Workout[]>();
        for (const w of workouts) {
          workoutsByDate.set(w.date, [...(workoutsByDate.get(w.date) ?? []), w]);
        }

        const start = new Date(range.from);
        const end = new Date(range.to);
        const spanDays = Math.min(
          Math.max(Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1, 1),
          MAX_FETCH_DAYS,
        );

        const built: DayInfo[] = [];
        for (let i = 0; i < spanDays; i++) {
          const d = new Date(start);
          d.setDate(d.getDate() + i);
          const date = localDateKey(d);
          const meal = mealByDate.get(date);
          const dayWorkouts = workoutsByDate.get(date) ?? [];
          const burned = dayWorkouts.reduce((sum, w) => sum + (w.calories ?? 0), 0);
          const distance = dayWorkouts.reduce((sum, w) => sum + (w.distance ?? 0), 0);
          const calories = meal?.totals.calories ?? 0;
          const protein = meal?.totals.protein ?? 0;
          const steps = stepsByDate.get(date) ?? 0;
          const netCalories = computeNetCalories(calories, burned, g.netCalorieBurnFactor ?? 50);
          const hasData = (meal?.entries.length ?? 0) > 0 || dayWorkouts.length > 0 || steps > 0;
          built.push({
            date,
            calories,
            protein,
            burned,
            netCalories,
            steps,
            workoutCount: dayWorkouts.length,
            distance,
            hasData,
            entries: meal?.entries ?? [],
            workouts: dayWorkouts,
            overallScore: hasData
              ? (adherence(netCalories, g.calorieGoal, "atMost") + adherence(protein, g.proteinGoal, "atLeast")) / 2
              : 0,
          });
        }
        setDays(built);
      } catch (err) {
        setError(String(err instanceof Error ? err.message : err));
      } finally {
        setLoading(false);
      }
    })();
  }, [user, range.from, range.to]);

  function statusColor(d: DayInfo): string {
    if (!d.hasData) return "var(--muted)";
    if (d.netCalories > goals.calorieGoal) return "var(--calories)";
    if (d.protein < goals.proteinGoal) return "var(--danger)";
    return "var(--burned)";
  }

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
        <h1>{t("navHistory")}</h1>
        <p style={{ color: "var(--muted)" }}>{t("signInPrompt")}</p>
        <button onClick={() => signIn()}>{t("signInWithGoogle")}</button>
        {authError && <p style={{ color: "#ff6b6b", fontSize: 13 }}>{t("signInFailed")}: {authError}</p>}
      </main>
    );
  }

  const last7 = days.slice(-7);
  const selected = days.find((d) => d.date === selectedDate) ?? null;
  const today = localDateKey();

  return (
    <main>
      <h1>{t("navHistory")}</h1>

      {error && <p style={{ color: "#ff6b6b" }}>{error}</p>}

      {loading ? (
        <p style={{ color: "var(--muted)" }}>{t("loading")}</p>
      ) : (
        <>
          <div style={{ display: "flex", gap: 6, marginTop: 16 }}>
            {last7.map((d) => {
              const isToday = d.date === today;
              const dayNum = Number(d.date.slice(8, 10));
              return (
                <button
                  key={d.date}
                  onClick={() => setSelectedDate(d.date)}
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 4,
                    padding: 8,
                    borderRadius: 8,
                    border: isToday ? "1.5px solid var(--text)" : "0.5px solid var(--border)",
                    background: isToday ? "var(--bg-muted)" : "var(--panel)",
                  }}
                >
                  <bdi dir="ltr" style={{ fontSize: 11, color: "var(--muted)" }}>
                    {dayNum}
                  </bdi>
                  <span style={{ fontSize: 10, color: "var(--muted)" }}>{weekdayLabel(d.date, lang)}</span>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor(d) }} />
                </button>
              );
            })}
          </div>

          <div style={{ display: "flex", gap: 12, fontSize: 12, color: "var(--muted)", marginTop: 8, flexWrap: "wrap" }}>
            <span>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "var(--burned)" }} /> {t("allGoalsMet")}
            </span>
            <span>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "var(--calories)" }} /> {t("calorieGoalMissed")}
            </span>
            <span>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "var(--danger)" }} /> {t("proteinGoalMissed")}
            </span>
            <span>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "var(--muted)" }} /> {t("noDataLogged")}
            </span>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 24, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={() => setPeriod("weekly")} style={{ fontWeight: period === "weekly" ? 700 : 400 }}>
              {t("last7Days")}
            </button>
            <button onClick={() => setPeriod("monthly")} style={{ fontWeight: period === "monthly" ? 700 : 400 }}>
              {t("last30Days")}
            </button>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="date"
                value={customFrom}
                max={customTo}
                onChange={(e) => {
                  setCustomFrom(e.target.value);
                  setPeriod("custom");
                }}
                style={{ padding: 6, borderRadius: 8, border: "0.5px solid var(--border)" }}
              />
              <span style={{ color: "var(--muted)" }}>–</span>
              <input
                type="date"
                value={customTo}
                min={customFrom}
                max={today}
                onChange={(e) => {
                  setCustomTo(e.target.value);
                  setPeriod("custom");
                }}
                style={{ padding: 6, borderRadius: 8, border: "0.5px solid var(--border)" }}
              />
            </span>
          </div>

          <MetricBarChart
            days={days}
            valueKey="calories"
            goal={goals.calorieGoal}
            label={t("caloriesVsGoal")}
            identityColorVar="var(--calories)"
            badColorVar="var(--calories)"
            badColorLightVar="var(--calories-light)"
            goalDirection="atMost"
            goodLabel={t("calorieGoalMet")}
            badLabel={t("calorieGoalMissed")}
            goalLabel={
              <>
                {t("goal")}: <bdi dir="ltr">{goals.calorieGoal} kcal</bdi> · {t("netAdjustedNote")}
              </>
            }
            unit=" kcal"
            yStep={500}
            onSelectDay={setSelectedDate}
            perDayGoal={(d) => goals.calorieGoal + d.burned * ((goals.netCalorieBurnFactor ?? 50) / 100)}
          />
          <MetricBarChart
            days={days}
            valueKey="protein"
            goal={goals.proteinGoal}
            label={t("proteinVsGoal")}
            identityColorVar="var(--protein)"
            badColorVar="var(--danger)"
            badColorLightVar="var(--danger-light)"
            goalDirection="atLeast"
            goodLabel={t("proteinGoalMet")}
            badLabel={t("proteinGoalMissed")}
            goalLabel={
              <>
                {t("goal")}: <bdi dir="ltr">{goals.proteinGoal}{gramsUnit}</bdi>
              </>
            }
            unit={gramsUnit}
            yStep={50}
            onSelectDay={setSelectedDate}
          />
          <MetricBarChart
            days={days}
            valueKey="overallScore"
            goal={100}
            label={t("overallVsGoal")}
            identityColorVar="var(--net)"
            badColorVar="var(--danger)"
            badColorLightVar="var(--danger-light)"
            goalDirection="atLeast"
            goodLabel={t("overallGoalMet")}
            badLabel={t("overallGoalMissed")}
            goalLabel={
              <>
                {t("goal")}: <bdi dir="ltr">100%</bdi>
              </>
            }
            unit="%"
            yStep={50}
            onSelectDay={setSelectedDate}
          />
          <MetricBarChart
            days={days}
            valueKey="steps"
            goal={goals.stepGoal ?? 10000}
            label={t("stepsVsGoal")}
            identityColorVar="var(--burned)"
            badColorVar="var(--danger)"
            badColorLightVar="var(--danger-light)"
            goalDirection="atLeast"
            goodLabel={t("stepsGoalMet")}
            badLabel={t("stepsGoalMissed")}
            goalLabel={
              <>
                {t("goal")}: <bdi dir="ltr">{goals.stepGoal ?? 10000}</bdi>
              </>
            }
            unit=""
            yStep={2000}
            onSelectDay={setSelectedDate}
            severityWhenBad
          />
          <SimpleBarChart
            days={days}
            valueOf={(d) => d.workoutCount}
            label={t("workoutsPerDayTitle")}
            identityColorVar="var(--protein)"
            unit=""
            yStep={1}
          />
          <SimpleBarChart
            days={days}
            valueOf={(d) => d.distance / 1000}
            label={t("distancePerDayTitle")}
            identityColorVar="var(--calories)"
            unit=" km"
            yStep={5}
            secondValueOf={(d) => d.steps / AVERAGE_STEPS_PER_KM}
            secondLabel={t("distanceFromStepsLabel")}
            secondColorVar="var(--burned)"
          />
          <SimpleBarChart
            days={days}
            valueOf={(d) => d.burned}
            label={t("caloriesBurnedPerDayTitle")}
            identityColorVar="var(--burned)"
            unit=" kcal"
            yStep={200}
          />
        </>
      )}

      {selected && (
        <div
          className="card"
          style={{
            position: "fixed",
            top: 0,
            bottom: 0,
            insetInlineEnd: 0,
            width: 320,
            maxWidth: "90%",
            borderRadius: 0,
            padding: 16,
            overflowY: "auto",
            zIndex: 60,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <h2 style={{ margin: 0 }}>
              <bdi dir="ltr">{fullDateLabel(selected.date)}</bdi> {weekdayLabel(selected.date, lang)}
            </h2>
            <button onClick={() => setSelectedDate(null)} style={{ border: "none", background: "none" }}>
              ✕
            </button>
          </div>
          <p style={{ color: "var(--muted)" }}>
            <bdi dir="ltr">{Math.round(selected.calories)}</bdi> {t("calories")} ·{" "}
            <bdi dir="ltr">
              {Math.round(selected.protein)}
              {gramsUnit}
            </bdi>{" "}
            {t("protein")}
          </p>
          <p style={{ color: "var(--net)", margin: "4px 0 0" }}>
            {t("net")}: <bdi dir="ltr">{Math.round(selected.netCalories)} kcal</bdi> ·{" "}
            {selected.netCalories <= goals.calorieGoal ? t("deficit") : t("surplus")}{" "}
            <bdi dir="ltr">{Math.abs(Math.round(selected.netCalories - goals.calorieGoal))}</bdi>
          </p>
          {selected.steps > 0 && (
            <p style={{ color: "var(--burned)", margin: "4px 0 0" }}>
              {t("steps")}: <bdi dir="ltr">{selected.steps}</bdi> / <bdi dir="ltr">{goals.stepGoal ?? 10000}</bdi>
            </p>
          )}

          <h3>{t("meals")}</h3>
          {selected.entries.length === 0 ? (
            <p style={{ color: "var(--muted)" }}>{t("noWorkoutsToday")}</p>
          ) : (
            selected.entries.map((e) => (
              <div key={e.id} style={{ padding: "4px 0", borderTop: "0.5px solid var(--border)" }}>
                <strong>{e.name}</strong> —{" "}
                <bdi dir="ltr">
                  {Math.round(e.calories)} kcal, {Math.round(e.protein)}
                  {t("unitG")}
                </bdi>
                {e.ingredients && e.ingredients.length > 0 && (
                  <div style={{ color: "var(--muted)", fontSize: 12 }}>
                    {t("ingredients")}: {e.ingredients.join(", ")}
                  </div>
                )}
              </div>
            ))
          )}

          <h3>{t("workouts")}</h3>
          {selected.workouts.length === 0 ? (
            <p style={{ color: "var(--muted)" }}>{t("noWorkoutsToday")}</p>
          ) : (
            selected.workouts.map((w) => (
              <div key={w.id} style={{ padding: "4px 0", borderTop: "0.5px solid var(--border)" }}>
                <strong>{w.type}</strong> —{" "}
                <bdi dir="ltr">
                  {Math.round(w.duration / 60)} min
                  {w.distance != null && `, ${(w.distance / 1000).toFixed(1)} km`}
                  {w.pace != null && `, ${formatPaceSecPerKm(w.pace)}`}
                  {w.calories != null && `, ${Math.round(w.calories)} kcal`}
                  {w.heartRate?.avg != null && `, ${t("avgHr")} ${Math.round(w.heartRate.avg)}`}
                  {w.elevationGain != null && `, +${Math.round(w.elevationGain)}m`}
                </bdi>
              </div>
            ))
          )}
        </div>
      )}
    </main>
  );
}
