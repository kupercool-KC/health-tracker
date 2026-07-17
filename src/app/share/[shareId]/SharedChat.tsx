"use client";

/**
 * Public, read-only view of a shared chat snapshot (sharedChats/{shareId}).
 * No auth required — firestore.rules allows public read on this collection
 * specifically (see docs/data-model.md), since the shareId itself is the
 * unguessable credential.
 */
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { useI18n } from "@/lib/i18n/useI18n";
import type { SharedChat as SharedChatDoc } from "@/lib/types";

export default function SharedChat() {
  const params = useParams<{ shareId: string }>();
  const { t } = useI18n();
  const [chat, setChat] = useState<SharedChatDoc | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    const shareId = params?.shareId;
    if (!shareId) return;
    (async () => {
      const snap = await getDoc(doc(db, "sharedChats", shareId));
      if (!snap.exists()) {
        setNotFound(true);
        return;
      }
      setChat(snap.data() as SharedChatDoc);
    })();
  }, [params?.shareId]);

  if (notFound) {
    return (
      <main>
        <p style={{ color: "var(--muted)" }}>Not found.</p>
      </main>
    );
  }

  if (!chat) {
    return (
      <main>
        <p style={{ color: "var(--muted)" }}>{t("loading")}</p>
      </main>
    );
  }

  return (
    <main>
      <h1>{chat.title || t("sharedChatTitle")}</h1>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
        {chat.messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%" }}>
            <div
              className="card"
              style={{ padding: 8, background: m.role === "user" ? "var(--protein-bg)" : "var(--bg-muted)", fontSize: 14 }}
            >
              {m.content}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
