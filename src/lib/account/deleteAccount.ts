/**
 * Permanently deletes a user and everything we hold about them (App Store
 * guideline 5.1.1(v) requires in-app account deletion). Order matters little
 * but the Auth user goes last, so a mid-way failure leaves an account the user
 * can still sign in to and retry.
 *
 * Not covered: sharedChats snapshots the user created (public by unguessable
 * link, stored without an owner id) — they stay readable by whoever has the link.
 */
import "server-only";
import { adminAuth, adminDb, adminStorage } from "@/lib/firebase/admin";

export async function deleteAccount(uid: string): Promise<void> {
  const userRef = adminDb.collection("users").doc(uid);

  // Reverse-lookup records that point at this uid.
  const userDoc = (await userRef.get()).data() as { healthTokenHash?: string } | undefined;
  if (userDoc?.healthTokenHash) await adminDb.collection("healthTokens").doc(userDoc.healthTokenHash).delete();

  const links = await adminDb.collection("whatsappLinks").where("uid", "==", uid).get();
  await Promise.all(links.docs.map((d) => d.ref.delete()));
  const codes = await adminDb.collection("whatsappLinkCodes").where("uid", "==", uid).get();
  await Promise.all(codes.docs.map((d) => d.ref.delete()));
  await adminDb.collection("whatsappReminders").doc(uid).delete();

  // Uploaded photos (meal / workout / steps screenshots, WhatsApp images).
  await adminStorage.bucket().deleteFiles({ prefix: `users/${uid}/` });

  // Everything under users/{uid}: meals, workouts, steps, chats, meta, memory, feedback, billing…
  await adminDb.recursiveDelete(userRef);

  await adminAuth.deleteUser(uid).catch((err: { code?: string }) => {
    if (err?.code !== "auth/user-not-found") throw err;
  });
}
