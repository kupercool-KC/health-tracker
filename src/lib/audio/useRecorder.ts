"use client";

/**
 * Minimal MediaRecorder wrapper for short voice clips (meal / workout / steps
 * dictation). Picks a mimeType that both MediaRecorder and OpenAI's
 * transcription endpoint accept (webm/opus on Chrome & Firefox, mp4/aac on
 * Safari), caps the clip length, and hands the finished Blob to `onComplete`.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type RecorderState = "idle" | "recording" | "stopping";
export type RecorderError = "micDenied" | "micNotFound" | "micError";

const MAX_SECONDS = 60;

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t));
}

export function useRecorder(onComplete: (blob: Blob) => void) {
  const [state, setState] = useState<RecorderState>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<RecorderError | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const supported =
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia;

  const teardown = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  useEffect(() => teardown, [teardown]);

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state === "inactive") return;
    setState("stopping");
    rec.stop(); // → onstop builds the blob
  }, []);

  const cancel = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      rec.onstop = null;
      rec.stop();
    }
    teardown();
    setState("idle");
    setSeconds(0);
  }, [teardown]);

  const start = useCallback(async () => {
    if (!supported || state !== "idle") return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickMimeType();
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || mimeType || "audio/webm" });
        teardown();
        setState("idle");
        setSeconds(0);
        if (blob.size > 0) onCompleteRef.current(blob);
      };
      rec.start();
      setState("recording");
      setSeconds(0);
      tickRef.current = setInterval(() => {
        setSeconds((s) => {
          if (s + 1 >= MAX_SECONDS) {
            stop();
            return MAX_SECONDS;
          }
          return s + 1;
        });
      }, 1000);
    } catch (err) {
      teardown();
      setState("idle");
      const name = err instanceof Error ? err.name : "";
      setError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "micDenied"
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "micNotFound"
            : "micError",
      );
    }
  }, [supported, state, teardown, stop]);

  return { state, seconds, error, supported, start, stop, cancel };
}
