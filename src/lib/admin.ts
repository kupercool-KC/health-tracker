/**
 * Single hardcoded admin uid — this is a single-user app for now, but the
 * check exists so the admin page/config doc stay explicitly gated rather
 * than "any signed-in user." Keep this in sync with the matching literal in
 * firestore.rules (rules can't import JS constants).
 */
export const ADMIN_UID = "Jw9kXMN8aucpw53kqaAw12gtlaA2";

export function isAdmin(uid: string | null | undefined): boolean {
  return uid === ADMIN_UID;
}
