"use client";

/**
 * iOS-style scrollable number wheel for a numeric field — built on native
 * CSS scroll-snap rather than a gesture/animation library, so momentum and
 * snapping come from the browser for free on both iOS Safari and Android
 * Chrome. `value` reflects the caller's string state as-is (an empty string
 * stays empty — the wheel just displays at `min` — nothing is written back
 * until the user actually scrolls or taps an option), preserving these
 * fields' "leave it blank and let the AI estimate" behavior.
 */
import { useEffect, useMemo, useRef } from "react";

const ITEM_HEIGHT = 34;
const VISIBLE_ROWS = 3;

function buildOptions(min: number, max: number, step: number, decimals: number): number[] {
  const count = Math.round((max - min) / step);
  const options: number[] = [];
  for (let i = 0; i <= count; i++) {
    options.push(Number((min + i * step).toFixed(decimals)));
  }
  return options;
}

export default function WheelPicker({
  value,
  onChange,
  min,
  max,
  step = 1,
  decimals = 0,
  unit,
}: {
  /** The caller's raw string field state — "" is treated as "not yet chosen". */
  value: string;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  decimals?: number;
  unit?: string;
}) {
  const options = useMemo(() => buildOptions(min, max, step, decimals), [min, max, step, decimals]);
  const containerRef = useRef<HTMLDivElement>(null);
  const settleTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressScrollHandling = useRef(false);

  const numericValue = value === "" ? min : Number(value);
  const selectedIndex = useMemo(() => {
    let closest = 0;
    let closestDiff = Infinity;
    options.forEach((o, i) => {
      const diff = Math.abs(o - numericValue);
      if (diff < closestDiff) {
        closestDiff = diff;
        closest = i;
      }
    });
    return closest;
  }, [numericValue, options]);

  // Keep the wheel's scroll position in sync when the value changes from
  // outside (a frequent-meal pick, the clear-row button) — guarded so this
  // programmatic scroll doesn't get mistaken for a user scroll below.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    suppressScrollHandling.current = true;
    el.scrollTop = selectedIndex * ITEM_HEIGHT;
    const t = setTimeout(() => {
      suppressScrollHandling.current = false;
    }, 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIndex]);

  function handleScroll() {
    if (suppressScrollHandling.current) return;
    if (settleTimeout.current) clearTimeout(settleTimeout.current);
    // Wait for the snap scroll to settle rather than firing on every pixel
    // of scroll motion — onChange should reflect the option the wheel
    // actually stopped on.
    settleTimeout.current = setTimeout(() => {
      const el = containerRef.current;
      if (!el) return;
      const idx = Math.max(0, Math.min(options.length - 1, Math.round(el.scrollTop / ITEM_HEIGHT)));
      const next = options[idx];
      if (next !== numericValue) onChange(next);
    }, 120);
  }

  function formatOption(o: number): string {
    const text = decimals > 0 ? o.toFixed(decimals) : String(o);
    return unit ? `${text} ${unit}` : text;
  }

  return (
    <div style={{ position: "relative", width: "100%", minWidth: 78 }}>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{
          height: ITEM_HEIGHT * VISIBLE_ROWS,
          overflowY: "scroll",
          scrollSnapType: "y mandatory",
          borderRadius: 8,
          border: "0.5px solid var(--border)",
          background: "var(--panel)",
          WebkitOverflowScrolling: "touch",
        }}
      >
        <div style={{ height: ITEM_HEIGHT }} aria-hidden />
        {options.map((o, i) => (
          <div
            key={o}
            onClick={() => onChange(o)}
            style={{
              height: ITEM_HEIGHT,
              scrollSnapAlign: "center",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 15,
              fontWeight: i === selectedIndex ? 700 : 400,
              color: i === selectedIndex ? "var(--text)" : "var(--muted)",
              cursor: "pointer",
            }}
          >
            <bdi dir="ltr">{formatOption(o)}</bdi>
          </div>
        ))}
        <div style={{ height: ITEM_HEIGHT }} aria-hidden />
      </div>
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: ITEM_HEIGHT,
          left: 0,
          right: 0,
          height: ITEM_HEIGHT,
          borderTop: "1px solid var(--border)",
          borderBottom: "1px solid var(--border)",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
