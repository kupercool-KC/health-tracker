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

export interface UseAuthResult {
  user: User | null;
  loading: boolean;
  signIn: () => Promise<void>;
  signOutUser: () => Promise<void>;
}

export function useAuth(): UseAuthResult {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setPersistence(auth, indexedDBLocalPersistence).catch(() => {});
    // Completes the sign-in after signInWithRedirect bounces back from Google.
    getRedirectResult(auth).catch(() => {});
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const signIn = useCallback(async () => {
    await signInWithRedirect(auth, new GoogleAuthProvider());
  }, []);

  const signOutUser = useCallback(async () => {
    await signOut(auth);
  }, []);

  return { user, loading, signIn, signOutUser };
}
