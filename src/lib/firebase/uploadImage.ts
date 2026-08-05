"use client";

/**
 * Uploads a food photo to Firebase Storage under the signed-in user's own
 * path and returns its public download URL, for passing to /api/nutrition
 * instead of an inline data URL (keeps request bodies small and lets the
 * server route fetch the image itself).
 */
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { storage } from "@/lib/firebase/client";

const OPENAI_SUPPORTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/**
 * iPhones save Photos-library images as HEIC by default — a format
 * OpenAI's vision API rejects outright, which made photo uploads picked
 * from the library (as opposed to a fresh camera capture, which iOS Safari
 * usually re-encodes as JPEG on the way into a web `<input type=file>`)
 * silently fail end to end with no useful error surfaced to the user.
 * Re-encodes anything not already in a supported format to JPEG client-side
 * before it ever reaches Storage. Safari can decode HEIC via `<img>` (WebKit's
 * own HEIF support), so this works without a dedicated HEIC-decode library.
 */
async function normalizeForVision(file: File): Promise<Blob> {
  if (OPENAI_SUPPORTED_TYPES.has(file.type)) return file;

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Unable to decode image"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas not supported");
    ctx.drawImage(img, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Failed to encode JPEG"))), "image/jpeg", 0.9),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function uploadImage(uid: string, file: File, folder: string): Promise<string> {
  const blob = await normalizeForVision(file);
  const ext = blob.type === "image/jpeg" ? "jpg" : (file.name.split(".").pop() || "jpg");
  const path = `users/${uid}/${folder}/${crypto.randomUUID()}.${ext}`;
  const fileRef = ref(storage, path);
  await uploadBytes(fileRef, blob, { contentType: blob.type });
  return getDownloadURL(fileRef);
}

export function uploadNutritionImage(uid: string, file: File): Promise<string> {
  return uploadImage(uid, file, "nutrition-images");
}

/** Same pattern as uploadNutritionImage, for workout-summary screenshots. */
export function uploadWorkoutImage(uid: string, file: File): Promise<string> {
  return uploadImage(uid, file, "workout-images");
}

/** Same pattern as uploadNutritionImage, for step-count screenshots. */
export function uploadStepsImage(uid: string, file: File): Promise<string> {
  return uploadImage(uid, file, "steps-images");
}
