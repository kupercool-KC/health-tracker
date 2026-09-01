"use client";

/**
 * Voice-dictation control for the meal / chat text inputs. Records a short
 * clip, POSTs it to /api/transcribe, and hands the transcript back via
 * `onTranscript` (the caller appends it to its text field — nothing is
 * logged until the user submits, same as typing). Renders nothing on
 * browsers without MediaRecorder.
 */
import { useState } from "react";
import { auth } from "@/lib/firebase/client";
import { useI18n } from "@/lib/i18n/useI18n";
import { useRecorder } from "@/lib/audio/useRecorder";

function MicGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

export default function MicButton({
  onTranscript,
  disabled,
  compact = false,
}: {
  onTranscript: (text: string) => void;
  disabled?: boolean;
  /** Icon-only (no word labels) — for tight rows like the chat input. */
  compact?: boolean;
}) {
  const { t, lang } = useI18n();
  const [busy, setBusy] = useState(false); // transcribing
  const [sendError, setSendError] = useState<string | null>(null);

  async function handleBlob(blob: Blob) {
    setBusy(true);
    setSendError(null);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error("no-auth");
      const form = new FormData();
      form.append("audio", blob, "recording");
      form.append("lang", lang);
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      const text = typeof data.text === "string" ? data.text.trim() : "";
      if (text) onTranscript(text);
      else setSendError(t("voiceError"));
    } catch {
      setSendError(t("voiceError"));
    } finally {
      setBusy(false);
    }
  }

  const { state, seconds, error, supported, start, stop, cancel } = useRecorder(handleBlob);

  if (!supported) return null;

  const recording = state === "recording" || state === "stopping";
  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, "0");

  const errText =
    error === "micDenied"
      ? t("micDenied")
      : error === "micNotFound"
        ? t("micNoDevice")
        : error === "micError"
          ? t("voiceError")
          : sendError;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      {!recording && (
        <button
          type="button"
          className="btn btn-sm mic-btn"
          onClick={start}
          disabled={disabled || busy}
          aria-label={t("recordVoice")}
          title={t("recordVoice")}
        >
          {busy ? <span className="spinner" aria-hidden /> : <MicGlyph />}
          {!compact && <span>{busy ? t("transcribing") : t("recordVoice")}</span>}
        </button>
      )}

      {recording && (
        <>
          <button
            type="button"
            className="btn btn-sm mic-btn mic-btn--rec"
            onClick={stop}
            aria-label={t("stopRecording")}
          >
            <span className="mic-dot" aria-hidden />
            <bdi dir="ltr">
              {mm}:{ss}
            </bdi>
            {!compact && <span>{t("stopRecording")}</span>}
          </button>
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={cancel}
            aria-label={t("discardRecording")}
            title={t("discardRecording")}
          >
            ✕
          </button>
        </>
      )}

      {errText && <span style={{ color: "var(--danger)", fontSize: 12 }}>{errText}</span>}
    </span>
  );
}
