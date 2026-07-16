"use client";

/**
 * Client hook exposing the current Firebase Auth user and sign-in/out actions.
 * Wraps onAuthStateChanged so components re-render on login/logout.
 */
import { useEffect, useState, useCallback } from "react";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
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
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const signIn = useCallback(async () => {
    await signInWithPopup(auth, new GoogleAuthProvider());
  }, []);

  const signOutUser = useCallback(async () => {
    await signOut(auth);
  }, []);

  return { user, loading, signIn, signOutUser };
}
