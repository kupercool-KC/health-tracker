/**
 * Server-side counterpart to src/lib/firebase/uploadImage.ts (which only
 * runs in the browser) — uploads a WhatsApp-downloaded image buffer to
 * Firebase Storage under the linked user's own path, so it can be passed to
 * the vision parsers (and shown later in History/Today) exactly like a
 * web-uploaded photo. A long-lived signed URL is used instead of
 * file.makePublic() — fetchable by OpenAI without further auth, without
 * changing the bucket's own access rules.
 */
import "server-only";
import { adminStorage } from "@/lib/firebase/admin";

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export async function uploadWhatsAppImage(uid: string, buffer: Buffer, contentType: string, folder: string): Promise<string> {
  const ext = EXT_BY_MIME[contentType] ?? "jpg";
  const path = `users/${uid}/${folder}/${crypto.randomUUID()}.${ext}`;
  const file = adminStorage.bucket().file(path);
  await file.save(buffer, { contentType, metadata: { contentType } });
  const [url] = await file.getSignedUrl({ action: "read", expires: "01-01-2100" });
  return url;
}
