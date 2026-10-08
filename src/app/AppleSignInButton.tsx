"use client";

import { useAuth } from "@/lib/firebase/useAuth";
import { useI18n } from "@/lib/i18n/useI18n";

/** "Sign in with Apple" — rendered only inside the iOS app (App Store guideline 4.8: required whenever another third-party login is offered). */
export default function AppleSignInButton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  const { signInWithApple, isNativeApp } = useAuth();
  const { t } = useI18n();
  if (!isNativeApp) return null;
  return (
    <button className={className} onClick={() => signInWithApple()} style={{ marginTop: 8, ...style }}>
      {t("signInWithApple")}
    </button>
  );
}
