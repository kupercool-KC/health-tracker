"use client";

/**
 * Chat panel: sessions sidebar (new/rename/delete/share) + message thread.
 * Message *content* always comes from POST /api/chat (server decides intent
 * and generates replies) — this component only sends user input and renders
 * what comes back, plus lets the user confirm a pending meal via the
 * existing POST /api/nutrition (passing the already-parsed result so it
 * doesn't get re-parsed).
 */
import { useEffect, useState } from "react";
import { collection, deleteDoc, doc, onSnapshot, orderBy, query, updateDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/useAuth";
import { useI18n } from "@/lib/i18n/useI18n";
import { localDateKey } from "@/lib/dashboard/queries";
import type { ChatMessage, ChatSession } from "@/lib/types";

export default function ChatPanel({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const { t, lang } = useI18n();

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const [confirmedIndices, setConfirmedIndices] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "users", user.uid, "chatSessions"), orderBy("updatedAt", "desc"));
    const unsubscribe = onSnapshot(q, (snap) => {
      setSessions(snap.docs.map((d) => d.data() as ChatSession));
    });
    return unsubscribe;
  }, [user]);

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;

  async function send(e: React.FormEvent | React.KeyboardEvent) {
    e.preventDefault();
    if (!user || (!text.trim() && !file) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) throw new Error("Not signed in");
      const idToken = await currentUser.getIdToken();

      let imageUrl: string | undefined;
      if (file) {
        const { uploadNutritionImage } = await import("@/lib/firebase/uploadImage");
        imageUrl = await uploadNutritionImage(currentUser.uid, file);
      }

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ sessionId: activeId ?? undefined, message: text, imageUrl, lang }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
      const data: { sessionId: string } = await res.json();
      setActiveId(data.sessionId);
      setText("");
      setFile(null);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmMeal(pendingMeal: NonNullable<ChatMessage["pendingMeal"]>, index: number) {
    setBusy(true);
    setError(null);
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) throw new Error("Not signed in");
      const idToken = await currentUser.getIdToken();
      const { imageUrl, ...parsed } = pendingMeal;
      const res = await fetch("/api/nutrition", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ parsed, imageUrl, date: localDateKey() }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
      setConfirmedIndices((prev) => new Set(prev).add(index));
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
    <div
      className="card"
      style={{
        position: "fixed",
        bottom: 80,
        insetInlineEnd: 16,
        insetInlineStart: 16,
        top: 80,
        maxWidth: 420,
        marginInlineStart: "auto",
        display: "flex",
        zIndex: 50,
        padding: 0,
        overflow: "hidden",
      }}
    >
      {sidebarOpen && (
        <aside style={{ width: 160, borderInlineEnd: "0.5px solid var(--border)", overflowY: "auto", padding: 8 }}>
          <button
            onClick={() => {
              setActiveId(null);
              setSidebarOpen(false);
            }}
            style={{ width: "100%", marginBottom: 8 }}
          >
            {t("newChat")}
          </button>
          {sessions.length === 0 && <p style={{ color: "var(--muted)", fontSize: 12 }}>{t("noSessions")}</p>}
          {sessions.map((s) => (
            <div key={s.id} style={{ marginBottom: 4 }}>
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
                    background: s.id === activeId ? "var(--protein-bg)" : "none",
                    border: "none",
                    padding: 4,
                  }}
                >
                  {s.title}
                </button>
              )}
              <div style={{ display: "flex", gap: 4, fontSize: 10 }}>
                <button
                  onClick={() => {
                    setRenamingId(s.id);
                    setRenameValue(s.title);
                  }}
                  style={{ border: "none", background: "none", padding: 2 }}
                >
                  {t("rename")}
                </button>
                <button onClick={() => shareSession(s.id)} style={{ border: "none", background: "none", padding: 2 }}>
                  {t("share")}
                </button>
                <button
                  onClick={() => deleteSession(s.id)}
                  style={{ border: "none", background: "none", padding: 2, color: "var(--calories)" }}
                >
                  {t("delete")}
                </button>
              </div>
            </div>
          ))}
        </aside>
      )}

      <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: 12, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <button onClick={() => setSidebarOpen((v) => !v)} style={{ border: "none", background: "none" }}>
            ☰
          </button>
          <button onClick={onClose} style={{ border: "none", background: "none" }}>
            ✕
          </button>
        </div>

        {shareNotice && <p style={{ color: "var(--burned)", fontSize: 12 }}>{shareNotice}</p>}

        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
          {(activeSession?.messages ?? []).map((m, i) => (
            <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%" }}>
              <div
                className="card"
                style={{ padding: 8, background: m.role === "user" ? "var(--protein-bg)" : "var(--bg-muted)", fontSize: 13 }}
              >
                {m.content}
              </div>
              {m.pendingMeal && (
                confirmedIndices.has(i) ? (
                  <p style={{ color: "var(--burned)", fontSize: 12, margin: "4px 0 0" }}>{t("saved")}</p>
                ) : (
                  <button onClick={() => confirmMeal(m.pendingMeal!, i)} disabled={busy} style={{ marginTop: 4 }}>
                    {t("confirm")}
                  </button>
                )
              )}
            </div>
          ))}
        </div>

        {error && <p style={{ color: "#ff6b6b", fontSize: 12 }}>{error}</p>}

        <form onSubmit={send} style={{ display: "flex", gap: 4, marginTop: 8 }}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) send(e);
            }}
            placeholder={t("chatPlaceholder")}
            style={{ flex: 1, padding: 8, borderRadius: 8, border: "0.5px solid var(--border)", minWidth: 0 }}
          />
          <label style={{ display: "flex", alignItems: "center", cursor: "pointer" }}>
            📷
            <input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ display: "none" }} />
          </label>
          <button type="submit" disabled={busy}>
            {t("send")}
          </button>
        </form>
      </div>
    </div>
  );
}
