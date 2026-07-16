/**
 * Per-user Health Sync tokens. Each user mints their own long-lived token
 * (from the Settings UI) instead of everyone sharing one secret. The plaintext
 * token is shown to the user exactly once; only its SHA-256 hash is stored, so
 * a Firestore leak doesn't hand out usable tokens.
 *
 * Firestore layout:
 *   healthTokens/{sha256(token)} -> { uid, createdAt }   (server-only, no client access)
 *   users/{uid}.healthTokenHash  -> string                (tracks the current hash, for revocation)
 */
import "server-only";
import crypto from "node:crypto";
import { adminDb } from "@/lib/firebase/admin";

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Mints a new token for `uid`, revoking any previous one. Returns the plaintext token. */
export async function createHealthToken(uid: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const hash = hashToken(token);

  const userRef = adminDb.collection("users").doc(uid);
  const userSnap = await userRef.get();
  const oldHash: string | undefined = userSnap.data()?.healthTokenHash;

  const batch = adminDb.batch();
  if (oldHash) {
    batch.delete(adminDb.collection("healthTokens").doc(oldHash));
  }
  batch.set(adminDb.collection("healthTokens").doc(hash), {
    uid,
    createdAt: new Date().toISOString(),
  });
  batch.set(userRef, { healthTokenHash: hash }, { merge: true });
  await batch.commit();

  return token;
}

/** Resolves a plaintext token from a Shortcut request back to its owning uid, or null. */
export async function resolveUidFromHealthToken(token: string): Promise<string | null> {
  const doc = await adminDb.collection("healthTokens").doc(hashToken(token)).get();
  return (doc.data()?.uid as string | undefined) ?? null;
}

/** Revokes the current token for `uid`, if any. */
export async function revokeHealthToken(uid: string): Promise<void> {
  const userRef = adminDb.collection("users").doc(uid);
  const userSnap = await userRef.get();
  const oldHash: string | undefined = userSnap.data()?.healthTokenHash;
  if (!oldHash) return;

  const batch = adminDb.batch();
  batch.delete(adminDb.collection("healthTokens").doc(oldHash));
  batch.set(userRef, { healthTokenHash: null }, { merge: true });
  await batch.commit();
}
