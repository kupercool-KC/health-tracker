"use client";

/**
 * Client hook exposing the current Firebase Auth user and sign-in/out actions.
 * Wraps onAuthStateChanged so components re-render on login/logout.
 *
 * Uses signInWithPopup on most browsers: signInWithRedirect has its own
 * SDK-internal async step (createAuthUri) before it navigates, and by the
 * time that resolves, the navigation is no longer tied closely enough to the
 * original click for some browsers to allow it — it just silently no-ops
 * (confirmed via a live repro: repeated createAuthUri calls, 200 OK, with no
 * subsequent navigation to Google at all). A popup opens synchronously in
 * the click handler, sidestepping that.
 *
 * signInWithRedirect is kept as the path on iOS Safari specifically: popups
 * are unreliable there (blocked outright in some contexts, and even when
 * allowed, Safari's tracking prevention can partition the popup's storage
 * from the opener's, so the sign-in never makes it back to the main page —
 * this was the actual cause of "have to log in every time" on iPhone, not a
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
  signInWithPopup,
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

/** Popups are unreliable specifically on iOS Safari — see the file header comment. */
function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua);
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  return isIos && isSafari;
}

/**
 * Set right before signInWithRedirect navigates away, cleared once we've
 * checked for a result on the way back. Distinguishes "the user never
 * tried to sign in" from "they did, the round trip to Google completed,
 * but Firebase came back with nothing" — the latter throws no error at
 * all (getRedirectResult just resolves to null), so without this marker
 * there's no way to tell the two apart and surface a real message instead
 * of silence. The actual cause (confirmed against this project's own
 * Firebase config): authDomain is the default *.firebaseapp.com, a
 * different site than where the app is hosted, so Safari's cross-site
 * tracking prevention can partition the storage the redirect needs to
 * hand the credential back.
 */
const REDIRECT_PENDING_KEY = "authRedirectPending";

/** Special (non-Firebase) authError code for the silent-redirect-loss case above — checked by name at every authError display site. */
export const AUTH_REDIRECT_LOST = "auth/redirect-lost";

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
    const hadPendingRedirect =
      typeof window !== "undefined" && sessionStorage.getItem(REDIRECT_PENDING_KEY) === "1";
    // Completes the sign-in after signInWithRedirect bounces back from
    // Google. This used to swallow errors entirely (`.catch(() => {})`),
    // which is exactly why a failed redirect just silently dumps you back
    // on the sign-in screen with zero clue why — log + surface it instead.
    getRedirectResult(auth)
      .then((result) => {
        if (!hadPendingRedirect) return;
        sessionStorage.removeItem(REDIRECT_PENDING_KEY);
        if (!result) {
          // No error was thrown, but we know a redirect was actually in
          // flight (the marker) and Firebase has nothing to show for it —
          // the round trip to Google completed with no usable credential.
          // See AUTH_REDIRECT_LOST's definition above for why.
          console.error("[auth] redirect completed with no credential (likely cross-site storage partitioning)");
          setAuthError(AUTH_REDIRECT_LOST);
        }
      })
      .catch((err) => {
        sessionStorage.removeItem(REDIRECT_PENDING_KEY);
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
    const provider = new GoogleAuthProvider();
    try {
      if (isIosSafari()) {
        sessionStorage.setItem(REDIRECT_PENDING_KEY, "1");
        await signInWithRedirect(auth, provider);
      } else {
        await signInWithPopup(auth, provider);
      }
    } catch (err) {
      sessionStorage.removeItem(REDIRECT_PENDING_KEY);
      console.error("[auth] sign-in failed:", err);
      setAuthError(authErrorCode(err));
    }
  }, []);

  const signOutUser = useCallback(async () => {
    await signOut(auth);
  }, []);

  return { user, loading, authError, signIn, signOutUser };
}
