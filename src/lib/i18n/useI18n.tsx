"use client";

/**
 * Language is stored per-user at users/{uid}/meta/profile.language and
 * mirrored to <html dir> for RTL. Defaults to "en" for signed-out users and
 * users who haven't onboarded yet (no profile doc).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/useAuth";
import { strings, type Language, type StringKey } from "./strings";

interface I18nContextValue {
  lang: Language;
  dir: "ltr" | "rtl";
  t: (key: StringKey) => string;
  setLang: (lang: Language) => Promise<void>;
  /** Points toward the previous/parent screen — flips for RTL. */
  backArrow: string;
  /** Points toward the next/child screen — flips for RTL. */
  forwardArrow: string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [lang, setLangState] = useState<Language>("en");

  useEffect(() => {
    if (!user) {
      setLangState("en");
      return;
    }
    const ref = doc(db, "users", user.uid, "meta", "profile");
    const unsubscribe = onSnapshot(ref, (snap) => {
      const stored = snap.data()?.language;
      setLangState(stored === "he" ? "he" : "en");
    });
    return unsubscribe;
  }, [user]);

  const dir: "ltr" | "rtl" = lang === "he" ? "rtl" : "ltr";

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
  }, [lang, dir]);

  const setLang = useCallback(
    async (next: Language) => {
      setLangState(next); // optimistic — snapshot listener will confirm
      if (!user) return;
      const ref = doc(db, "users", user.uid, "meta", "profile");
      await setDoc(ref, { language: next, updatedAt: new Date().toISOString() }, { merge: true });
    },
    [user],
  );

  const t = useCallback((key: StringKey) => strings[key][lang], [lang]);

  const backArrow = dir === "rtl" ? "→" : "←";
  const forwardArrow = dir === "rtl" ? "←" : "→";

  const value = useMemo(
    () => ({ lang, dir, t, setLang, backArrow, forwardArrow }),
    [lang, dir, t, setLang, backArrow, forwardArrow],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
