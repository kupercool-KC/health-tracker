"use client";

/**
 * Client hook exposing the current Firebase Auth user and sign-in/out actions.
 * Wraps onAuthStateChanged so components re-render on login/logout.
 *
 * Uses signInWithRedirect instead of signInWithPopup: popups are unreliable
 * on iOS Safari (blocked outright in some contexts, and even when allowed,
 * Safari's tracking prevention can partition the popup's storage from the
 * opener's, so the sign-in never makes it back to the main page — this was
 * the actual cause of "have to log in every time" on iPhone, not a
 * persistence setting). Persistence is set explicitly to indexedDB-backed
 * local persistence (the default, but explicit here so it can't silently
 * fall back to session-only in an environment where indexedDB init races
 * the first getAuth() call).
 */
import { useEffect, useState, useCallback } from "react";
import {
  GoogleAuthProvider,
  getRedirectResult,
  indexedDBLocalPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithRedirect,
  signOut,
  type User,
} from "firebase/auth";
import { auth } from "@/lib/firebase/client";

/** Firebase SDK errors always carry a `.code` (e.g. "auth/popup-blocked") — narrower and more useful than the generic message. */
function authErrorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  return String(err);
}

export interface UseAuthResult {
  user: User | null;
  loading: boolean;
  /** Set when signInWithRedirect bounced back without completing — e.g. a
   * browser blocking third-party storage during the redirect can silently
   * drop the sign-in, which otherwise just looks like "nothing happened". */
  authError: string | null;
  signIn: () => Promise<void>;
  signOutUser: () => Promise<void>;
}

export function useAuth(): UseAuthResult {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    setPersistence(auth, indexedDBLocalPersistence).catch(() => {});
    // Completes the sign-in after signInWithRedirect bounces back from
    // Google. This used to swallow errors entirely (`.catch(() => {})`),
    // which is exactly why a failed redirect just silently dumps you back
    // on the sign-in screen with zero clue why — log + surface it instead.
    getRedirectResult(auth).catch((err) => {
      console.error("[auth] getRedirectResult failed:", err);
      setAuthError(authErrorCode(err));
    });
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const signIn = useCallback(async () => {
    setAuthError(null);
    try {
      await signInWithRedirect(auth, new GoogleAuthProvider());
    } catch (err) {
      console.error("[auth] signInWithRedirect failed:", err);
      setAuthError(authErrorCode(err));
    }
  }, []);

  const signOutUser = useCallback(async () => {
    await signOut(auth);
  }, []);

  return { user, loading, authError, signIn, signOutUser };
}
