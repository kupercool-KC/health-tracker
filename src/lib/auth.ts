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
