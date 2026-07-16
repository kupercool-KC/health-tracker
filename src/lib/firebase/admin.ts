/**
 * Firebase Admin SDK — server-only. Used by API routes to verify ID tokens and
 * write data with elevated privileges. Never import this from a client
 * component.
 */
import "server-only";
import {
  initializeApp,
  getApps,
  cert,
  applicationDefault,
  type App,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

function initAdmin(): App {
  if (getApps().length) return getApps()[0];

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    return initializeApp({
      credential: cert(JSON.parse(raw)),
      projectId: process.env.FIREBASE_PROJECT_ID,
    });
  }

  // Falls back to GOOGLE_APPLICATION_CREDENTIALS / ambient credentials.
  return initializeApp({
    credential: applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
}

const app = initAdmin();
export const adminAuth = getAuth(app);
export const adminDb = getFirestore(app);
