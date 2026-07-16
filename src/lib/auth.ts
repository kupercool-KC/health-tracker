/**
 * Server-side auth helpers for API routes.
 */
import "server-only";
import { adminAuth } from "@/lib/firebase/admin";

/**
 * Verify the Firebase ID token from an `Authorization: Bearer <token>` header.
 * Returns the uid, or null if missing/invalid.
 */
export async function getUidFromRequest(req: Request): Promise<string | null> {
  const header = req.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    return decoded.uid;
  } catch {
    return null;
  }
}

/**
 * Constant-time-ish check of the shared Health ingest secret. The iOS Shortcut
 * sends `Authorization: Bearer <HEALTH_INGEST_TOKEN>`.
 */
export function isValidHealthToken(req: Request): boolean {
  const expected = process.env.HEALTH_INGEST_TOKEN;
  if (!expected) return false; // fail closed if unconfigured
  const header = req.headers.get("authorization");
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!provided || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}
