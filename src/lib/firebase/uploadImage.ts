"use client";

/**
 * Uploads a food photo to Firebase Storage under the signed-in user's own
 * path and returns its public download URL, for passing to /api/nutrition
 * instead of an inline data URL (keeps request bodies small and lets the
 * server route fetch the image itself).
 */
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { storage } from "@/lib/firebase/client";

export async function uploadNutritionImage(uid: string, file: File): Promise<string> {
  const ext = file.name.split(".").pop() || "jpg";
  const path = `users/${uid}/nutrition-images/${crypto.randomUUID()}.${ext}`;
  const fileRef = ref(storage, path);
  await uploadBytes(fileRef, file, { contentType: file.type });
  return getDownloadURL(fileRef);
}

/** Same pattern as uploadNutritionImage, for workout-summary screenshots. */
export async function uploadWorkoutImage(uid: string, file: File): Promise<string> {
  const ext = file.name.split(".").pop() || "jpg";
  const path = `users/${uid}/workout-images/${crypto.randomUUID()}.${ext}`;
  const fileRef = ref(storage, path);
  await uploadBytes(fileRef, file, { contentType: file.type });
  return getDownloadURL(fileRef);
}

/** Same pattern as uploadNutritionImage, for step-count screenshots. */
export async function uploadStepsImage(uid: string, file: File): Promise<string> {
  const ext = file.name.split(".").pop() || "jpg";
  const path = `users/${uid}/steps-images/${crypto.randomUUID()}.${ext}`;
  const fileRef = ref(storage, path);
  await uploadBytes(fileRef, file, { contentType: file.type });
  return getDownloadURL(fileRef);
}
