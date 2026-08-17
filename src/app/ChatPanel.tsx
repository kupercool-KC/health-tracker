"use client";

/**
 * Chat panel: sessions sidebar (new/rename/delete/share) + message thread.
 * Message *content* always comes from POST /api/chat (server decides intent
 * and generates replies) — this component only sends user input and renders
 * what comes back, plus lets the user confirm a pending meal via the
 * existing POST /api/nutrition (passing the already-parsed result so it
 * doesn't get re-parsed).
 */
import { useEffect, useRef, useState } from "react";
import { collection, deleteDoc, doc, onSnapshot, orderBy, query, updateDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/useAuth";
import { useI18n } from "@/lib/i18n/useI18n";
import { localDateKey } from "@/lib/dashboard/queries";
import type { ChatMessage, ChatSession } from "@/lib/types";

/** Same rationale as Today.tsx's apiErrorMessage — surface "detail" alongside "error" instead of dropping it. */
function apiErrorMessage(data: { error?: string; detail?: string }, fallback: string): string {
  const error = data.error ?? fallback;
  return data.detail ? `${error}: ${data.detail}` : error;
}

/**
 * Chat replies are freeform text from the model/server — unlike the rest of
 * the app's numbers (always individually wrapped in <bdi dir="ltr">), there's
 * no structured JSX to wrap here, just a string. A number-only run (digits,
 * "+"/"-"/"×"/"="/"%", decimal points) has no strong bidi character of its
 * own, so embedded in Hebrew text it can reorder unpredictably — e.g. a
 * multi-term formula like "177 + 119 + 88.4 = 384.4" landing before/after
 * the wrong Hebrew word, or a trailing sentence period jumping to the wrong
 * edge. Wrapping each such run in Unicode bidi isolate marks (U+2066/U+2069
 * — the plain-text equivalent of <bdi dir="ltr">) fixes this without needing
 * to parse the string into JSX.
 */
const BIDI_LTR_ISOLATE_START = "⁦"; // LEFT-TO-RIGHT ISOLATE
const BIDI_ISOLATE_END = "⁩"; // POP DIRECTIONAL ISOLATE
const NUMERIC_EXPRESSION_RE = /[+-]?\d+(?:[.,]\d+)?(?:\s*[-+×x*/=%]\s*[+-]?\d+(?:[.,]\d+)?)*/g;

function isolateNumbersForBidi(text: string, lang: "en" | "he"): string {
  if (lang !== "he") return text;
  return text.replace(NUMERIC_EXPRESSION_RE, (match) => `${BIDI_LTR_ISOLATE_START}${match}${BIDI_ISOLATE_END}`);
}

export default function ChatPanel({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const { t, lang } = useI18n();

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // "Extended" = wider drawer (more room to read full session titles);
  // default is a slimmer drawer that still leaves the message thread visible
  // underneath the backdrop on wider screens.
  const [sidebarExtended, setSidebarExtended] = useState(false);
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  // Resets the auto-grow textarea's height whenever `text` changes for any
  // reason — typing (handled inline in onChange too) but also programmatic
  // clears after sending, which don't fire a DOM input event.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [text]);
  const [file, setFile] = useState<File | null>(null);
  // A picked file previously gave zero visual feedback — this renders a
  // thumbnail so the user can actually see something was attached before
  // sending. Revoked whenever `file` changes, so picking a new photo (or
  // sending/clearing) doesn't leak the previous object URL.
  const [filePreviewUrl, setFilePreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setFilePreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setFilePreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const [manualCalories, setManualCalories] = useState("");
  const [manualProtein, setManualProtein] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  // Keyed by "{messageIndex}:{kind}", not just messageIndex — a single
  // message can carry more than one pending kind at once (e.g. a meal AND a
  // workout described together), each with its own independent Confirm
  // button; a plain index-only Set would mark all of them "saved" the
  // moment any ONE of them was confirmed.
  const [confirmedKeys, setConfirmedKeys] = useState<Set<string>>(new Set());
  // Separate from `busy` (which also covers confirm/rename/etc.) so the
  // thinking indicator only shows while actually waiting on /api/chat.
  const [awaitingReply, setAwaitingReply] = useState(false);
  // Message content is only ever written server-side (see file header), so
  // the real message list (activeSession.messages) doesn't show what you
  // just sent until the whole /api/chat round-trip finishes and Firestore's
  // onSnapshot delivers it. This renders it locally right away instead —
  // cleared once the persisted session actually contains it (see the effect
  // below), so there's no gap where "sent" isn't reflected on screen.
  const [pendingUserMessage, setPendingUserMessage] = useState<{ content: string } | null>(null);

  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "users", user.uid, "chatSessions"), orderBy("updatedAt", "desc"));
    const unsubscribe = onSnapshot(q, (snap) => {
      setSessions(snap.docs.map((d) => d.data() as ChatSession));
    });
    return unsubscribe;
  }, [user]);

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;

  // Drop the optimistic bubble the moment the real (persisted) message
  // shows up in the session — avoids a duplicate or a flash of "un-sent".
  useEffect(() => {
    if (!pendingUserMessage) return;
    const msgs = activeSession?.messages ?? [];
    // Check the whole list, not just the last entry — once the assistant's
    // reply is appended after the user's message, the last entry is the
    // assistant's, so a last-only check never matches again and the
    // optimistic bubble stays stuck on screen below the real reply forever.
    const found = msgs.some((m) => m.role === "user" && m.content === pendingUserMessage.content);
    if (found) setPendingUserMessage(null);
  }, [activeSession, pendingUserMessage]);

  // Jump to the bottom of the thread whenever a new message appears — the
  // user's own message the instant they send it (via pendingUserMessage),
  // the "thinking" indicator right after, and then the real reply once it
  // lands — instead of leaving them to scroll down manually each time.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [activeSession?.messages.length, pendingUserMessage, awaitingReply]);

  async function send(e: React.FormEvent | React.KeyboardEvent) {
    e.preventDefault();
    if (!user || (!text.trim() && !file) || busy) return;
    const messageText = text;
    const messageFile = file;
    const messageCalories = manualCalories;
    const messageProtein = manualProtein;
    // Clear the input immediately so it's ready for the next message —
    // the thinking indicator below covers the wait, not the input box.
    setText("");
    setFile(null);
    setManualCalories("");
    setManualProtein("");
    setBusy(true);
    setAwaitingReply(true);
    setError(null);
    setPendingUserMessage({ content: messageText.trim() || (lang === "he" ? "[תמונה]" : "[photo]") });
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) throw new Error("Not signed in");
      const idToken = await currentUser.getIdToken();

      let imageUrl: string | undefined;
      if (messageFile) {
        const { uploadNutritionImage } = await import("@/lib/firebase/uploadImage");
        imageUrl = await uploadNutritionImage(currentUser.uid, messageFile);
      }

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          sessionId: activeId ?? undefined,
          message: messageText,
          imageUrl,
          lang,
          date: localDateKey(),
          overrideCalories: messageCalories ? Number(messageCalories) : undefined,
          overrideProtein: messageProtein ? Number(messageProtein) : undefined,
        }),
      });
      if (!res.ok) throw new Error(apiErrorMessage(await res.json().catch(() => ({})), res.statusText));
      const data: { sessionId: string } = await res.json();
      setActiveId(data.sessionId);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      // Restore the input on failure so the user doesn't lose what they typed.
      setText(messageText);
      setFile(messageFile);
      setManualCalories(messageCalories);
      setManualProtein(messageProtein);
      setPendingUserMessage(null);
    } finally {
      setBusy(false);
      setAwaitingReply(false);
    }
  }

  async function confirmMeal(pendingMeal: NonNullable<ChatMessage["pendingMeal"]>, index: number) {
    setBusy(true);
    setError(null);
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) throw new Error("Not signed in");
      const idToken = await currentUser.getIdToken();
      const { imageUrl, date, ...parsed } = pendingMeal;
      const res = await fetch("/api/nutrition", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ parsed, imageUrl, date: date ?? localDateKey() }),
      });
      if (!res.ok) throw new Error(apiErrorMessage(await res.json().catch(() => ({})), res.statusText));
      setConfirmedKeys((prev) => new Set(prev).add(`${index}:meal`));
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmWorkout(pendingWorkout: NonNullable<ChatMessage["pendingWorkout"]>, index: number) {
    setBusy(true);
    setError(null);
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) throw new Error("Not signed in");
      const idToken = await currentUser.getIdToken();
      const { imageUrl, date, ...parsed } = pendingWorkout;
      const res = await fetch("/api/workouts", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ parsed, imageUrl, date }),
      });
      if (!res.ok) throw new Error(apiErrorMessage(await res.json().catch(() => ({})), res.statusText));
      setConfirmedKeys((prev) => new Set(prev).add(`${index}:workout`));
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmSteps(pendingSteps: NonNullable<ChatMessage["pendingSteps"]>, index: number) {
    setBusy(true);
    setError(null);
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) throw new Error("Not signed in");
      const idToken = await currentUser.getIdToken();
      const res = await fetch("/api/steps", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ steps: pendingSteps.steps, date: pendingSteps.date }),
      });
      if (!res.ok) throw new Error(apiErrorMessage(await res.json().catch(() => ({})), res.statusText));
      setConfirmedKeys((prev) => new Set(prev).add(`${index}:steps`));
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmMealAction(pendingMealAction: NonNullable<ChatMessage["pendingMealAction"]>, index: number) {
    setBusy(true);
    setError(null);
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) throw new Error("Not signed in");
      const idToken = await currentUser.getIdToken();
      const { action, date, entryId, changes } = pendingMealAction;
      const res = await fetch("/api/nutrition", {
        method: action === "delete" ? "DELETE" : "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify(action === "delete" ? { date, entryId } : { date, entryId, changes }),
      });
      if (!res.ok) throw new Error(apiErrorMessage(await res.json().catch(() => ({})), res.statusText));
      setConfirmedKeys((prev) => new Set(prev).add(`${index}:mealAction`));
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  async function renameSession(id: string) {
    if (!user || !renameValue.trim()) {
      setRenamingId(null);
      return;
    }
    await updateDoc(doc(db, "users", user.uid, "chatSessions", id), { title: renameValue.trim() });
    setRenamingId(null);
  }

  async function deleteSession(id: string) {
    if (!user) return;
    if (!window.confirm(t("deleteConfirm"))) return;
    await deleteDoc(doc(db, "users", user.uid, "chatSessions", id));
    if (activeId === id) setActiveId(null);
  }

  async function shareSession(id: string) {
    if (!user) return;
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) return;
    const res = await fetch("/api/chat/share", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ sessionId: id }),
    });
    if (!res.ok) return;
    const data: { shareId: string } = await res.json();
    const url = `${window.location.origin}/share/${data.shareId}`;
    await navigator.clipboard.writeText(url);
    setShareNotice(t("shareLinkCreated"));
    setTimeout(() => setShareNotice(null), 3000);
  }

  return (
    <div className="card chat-panel">
      {/* Overlay drawer rather than a flex sibling that squeezes the message
          thread — on a narrow phone screen a fixed-width inline sidebar left
          barely any room for the chat itself. Tapping the backdrop or a
          session closes it, same as any standard mobile drawer. */}
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.25)", zIndex: 1 }}
        />
      )}
      <aside
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          width: sidebarExtended ? "min(88vw, 340px)" : "min(75vw, 220px)",
          transition: "inset-inline-start 0.2s ease",
          insetInlineStart: sidebarOpen ? 0 : "-100%",
          background: "var(--panel)",
          borderInlineEnd: "0.5px solid var(--border)",
          overflowY: "auto",
          padding: 12,
          zIndex: 2,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <button
            onClick={() => {
              setActiveId(null);
              setSidebarOpen(false);
            }}
            style={{ flex: 1, marginInlineEnd: 6 }}
          >
            ➕ {t("newChat")}
          </button>
          <button
            onClick={() => setSidebarExtended((v) => !v)}
            aria-label={sidebarExtended ? t("minimize") : t("extend")}
            title={sidebarExtended ? t("minimize") : t("extend")}
            style={{ border: "none", background: "none", padding: 6, fontSize: 14, flexShrink: 0 }}
          >
            {sidebarExtended ? "⇤⇥" : "⇥⇤"}
          </button>
        </div>
        {sessions.length === 0 && <p style={{ color: "var(--muted)", fontSize: 12 }}>{t("noSessions")}</p>}
        {sessions.map((s) => (
          <div
            key={s.id}
            className="card"
            style={{
              marginBottom: 8,
              padding: 8,
              background: s.id === activeId ? "var(--protein-bg)" : "var(--panel)",
            }}
          >
            {renamingId === s.id ? (
              <input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => renameSession(s.id)}
                onKeyDown={(e) => e.key === "Enter" && renameSession(s.id)}
                autoFocus
                style={{ width: "100%", fontSize: 12, padding: 4 }}
              />
            ) : (
              <button
                onClick={() => {
                  setActiveId(s.id);
                  setSidebarOpen(false);
                }}
                style={{
                  width: "100%",
                  textAlign: "start",
                  fontSize: 12,
                  background: "none",
                  border: "none",
                  padding: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                💬 {s.title}
              </button>
            )}
            <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
              <button
                onClick={() => {
                  setRenamingId(s.id);
                  setRenameValue(s.title);
                }}
                aria-label={t("rename")}
                title={t("rename")}
                style={{ border: "none", background: "none", padding: 2, fontSize: 13 }}
              >
                ✏️
              </button>
              <button
                onClick={() => shareSession(s.id)}
                aria-label={t("share")}
                title={t("share")}
                style={{ border: "none", background: "none", padding: 2, fontSize: 13 }}
              >
                🔗
              </button>
              <button
                onClick={() => deleteSession(s.id)}
                aria-label={t("delete")}
                title={t("delete")}
                style={{ border: "none", background: "none", padding: 2, fontSize: 13, color: "var(--calories)" }}
              >
                🗑️
              </button>
            </div>
          </div>
        ))}
      </aside>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: 12, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 8,
            paddingBottom: 8,
            borderBottom: "0.5px solid var(--border)",
          }}
        >
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            aria-label={t("newChat")}
            style={{ border: "none", background: "none", width: 40, height: 40, fontSize: 18 }}
          >
            ☰
          </button>
          <button onClick={onClose} aria-label={t("close")} style={{ border: "none", background: "none", width: 40, height: 40, fontSize: 18 }}>
            ✕
          </button>
        </div>

        {shareNotice && <p style={{ color: "var(--burned)", fontSize: 12 }}>{shareNotice}</p>}

        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
          {(activeSession?.messages ?? []).map((m, i) => (
            <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%" }}>
              <div
                className="card"
                dir={lang === "he" ? "rtl" : "ltr"}
                style={{
                  padding: 8,
                  background: m.role === "user" ? "var(--protein-bg)" : "var(--bg-muted)",
                  fontSize: 13,
                  whiteSpace: "pre-line",
                  lineHeight: 1.6,
                }}
              >
                {isolateNumbersForBidi(m.content, lang)}
              </div>
              {m.pendingMeal && (
                confirmedKeys.has(`${i}:meal`) ? (
                  <p style={{ color: "var(--burned)", fontSize: 12, margin: "4px 0 0" }}>{t("saved")}</p>
                ) : (
                  <button onClick={() => confirmMeal(m.pendingMeal!, i)} disabled={busy} style={{ marginTop: 4 }}>
                    {t("confirm")}
                  </button>
                )
              )}
              {m.pendingMealAction && (
                confirmedKeys.has(`${i}:mealAction`) ? (
                  <p style={{ color: "var(--burned)", fontSize: 12, margin: "4px 0 0" }}>{t("saved")}</p>
                ) : (
                  <button onClick={() => confirmMealAction(m.pendingMealAction!, i)} disabled={busy} style={{ marginTop: 4 }}>
                    {t("confirm")}
                  </button>
                )
              )}
              {m.pendingWorkout && (
                confirmedKeys.has(`${i}:workout`) ? (
                  <p style={{ color: "var(--burned)", fontSize: 12, margin: "4px 0 0" }}>{t("saved")}</p>
                ) : (
                  <button onClick={() => confirmWorkout(m.pendingWorkout!, i)} disabled={busy} style={{ marginTop: 4 }}>
                    {t("confirm")}
                  </button>
                )
              )}
              {m.pendingSteps && (
                confirmedKeys.has(`${i}:steps`) ? (
                  <p style={{ color: "var(--burned)", fontSize: 12, margin: "4px 0 0" }}>{t("saved")}</p>
                ) : (
                  <button onClick={() => confirmSteps(m.pendingSteps!, i)} disabled={busy} style={{ marginTop: 4 }}>
                    {t("confirm")}
                  </button>
                )
              )}
            </div>
          ))}
          {pendingUserMessage && (
            <div style={{ alignSelf: "flex-end", maxWidth: "85%" }}>
              <div
                className="card"
                dir={lang === "he" ? "rtl" : "ltr"}
                style={{
                  padding: 8,
                  background: "var(--protein-bg)",
                  fontSize: 13,
                  whiteSpace: "pre-line",
                  lineHeight: 1.6,
                  opacity: 0.7,
                }}
              >
                {isolateNumbersForBidi(pendingUserMessage.content, lang)}
              </div>
            </div>
          )}
          {awaitingReply && (
            <div style={{ alignSelf: "flex-start", maxWidth: "85%" }}>
              <div className="card thinking-bubble" style={{ padding: "10px 12px", background: "var(--bg-muted)" }}>
                <span className="thinking-dot" />
                <span className="thinking-dot" />
                <span className="thinking-dot" />
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <style>{`
          .thinking-bubble { display: flex; gap: 4px; align-items: center; }
          .thinking-dot {
            width: 6px; height: 6px; border-radius: 50%; background: var(--muted);
            animation: thinking-bounce 1.2s infinite ease-in-out;
          }
          .thinking-dot:nth-child(2) { animation-delay: 0.15s; }
          .thinking-dot:nth-child(3) { animation-delay: 0.3s; }
          @keyframes thinking-bounce {
            0%, 80%, 100% { opacity: 0.3; transform: translateY(0); }
            40% { opacity: 1; transform: translateY(-3px); }
          }
        `}</style>

        {error && (
          <details style={{ marginTop: 4 }}>
            <summary style={{ color: "#ff6b6b", fontSize: 12, cursor: "pointer" }}>{t("somethingWentWrong")}</summary>
            <p style={{ color: "#ff6b6b", fontSize: 11, marginTop: 4, whiteSpace: "pre-wrap" }}>{error}</p>
          </details>
        )}

        {file && (
          <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
            <input
              type="number"
              inputMode="numeric"
              value={manualCalories}
              onChange={(e) => setManualCalories(e.target.value)}
              placeholder={t("manualCaloriesPlaceholder")}
              style={{ flex: 1, padding: 8, borderRadius: 8, border: "0.5px solid var(--border)", fontSize: 13 }}
            />
            <input
              type="number"
              inputMode="numeric"
              value={manualProtein}
              onChange={(e) => setManualProtein(e.target.value)}
              placeholder={t("manualProteinPlaceholder")}
              style={{ flex: 1, padding: 8, borderRadius: 8, border: "0.5px solid var(--border)", fontSize: 13 }}
            />
          </div>
        )}

        <form onSubmit={send} style={{ display: "flex", gap: 4, marginTop: 8, alignItems: "center" }}>
          {file && filePreviewUrl && (
            <div style={{ position: "relative", flexShrink: 0, width: 40, height: 40 }}>
              <img
                src={filePreviewUrl}
                alt=""
                style={{ width: 40, height: 40, borderRadius: 8, objectFit: "cover", border: "0.5px solid var(--border)", display: "block" }}
              />
              <button
                type="button"
                onClick={() => setFile(null)}
                aria-label={t("removePhoto")}
                title={t("removePhoto")}
                style={{
                  position: "absolute",
                  top: -6,
                  insetInlineEnd: -6,
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  border: "none",
                  background: "var(--danger)",
                  color: "#fff",
                  fontSize: 10,
                  lineHeight: 1,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                }}
              >
                ×
              </button>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) send(e);
            }}
            placeholder={file ? t("photoCaptionPlaceholder") : t("chatPlaceholder")}
            rows={1}
            style={{
              flex: 1,
              padding: 8,
              borderRadius: 8,
              border: "0.5px solid var(--border)",
              minWidth: 0,
              resize: "none",
              maxHeight: 120,
              fontFamily: "inherit",
              fontSize: "inherit",
              lineHeight: 1.4,
            }}
          />
          <label title={t("photoUploadHint")} style={{ display: "flex", alignItems: "center", cursor: "pointer" }}>
            📷
            <input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ display: "none" }} />
          </label>
          <button type="submit" disabled={busy}>
            {awaitingReply ? <span className="send-spinner" aria-label={t("send")} /> : t("send")}
          </button>
        </form>
        <style>{`
          .send-spinner {
            display: inline-block;
            width: 12px;
            height: 12px;
            border: 2px solid currentColor;
            border-inline-end-color: transparent;
            border-radius: 50%;
            animation: send-spin 0.7s linear infinite;
          }
          @keyframes send-spin {
            to { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    </div>
  );
}
