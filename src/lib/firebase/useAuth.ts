"use client";

/**
 * Client hook exposing the current Firebase Auth user and sign-in/out actions.
 * Wraps onAuthStateChanged so components re-render on login/logout.
 *
 * Always uses signInWithPopup, on every browser including iOS Safari.
 * signInWithRedirect was tried there instead and dropped: the round trip
 * goes through Firebase's default *.firebaseapp.com authDomain, a different
 * site than where this app is hosted, and Safari's cross-site tracking
 * prevention can block the storage handoff needed to bring the credential
 * back — getRedirectResult() then just resolves to null with no error at
 * all, so sign-in silently fails and dumps the user back on the sign-in
 * screen. Popup has its own known Safari quirk (the signed-in session may
 * not persist reliably across visits, needing an occasional re-sign-in),
 * but that's a lesser evil than redirect's complete inability to sign in.
 * The real fix for both is a custom auth domain sharing this app's own
 * domain — not set up, since that requires a domain this project doesn't
 * own. Persistence is set explicitly to indexedDB-backed local persistence
 * (the default, but explicit here so it can't silently fall back to
 * session-only in an environment where indexedDB init races the first
 * getAuth() call).
 */
import { useEffect, useState, useCallback } from "react";
import {
  GoogleAuthProvider,
  indexedDBLocalPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
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
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const signIn = useCallback(async () => {
    setAuthError(null);
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error("[auth] sign-in failed:", err);
      setAuthError(authErrorCode(err));
    }
  }, []);

  const signOutUser = useCallback(async () => {
    await signOut(auth);
  }, []);

  return { user, loading, authError, signIn, signOutUser };
}
