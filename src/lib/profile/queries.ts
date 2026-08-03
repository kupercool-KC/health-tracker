"use client";

import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import type { UserProfile } from "@/lib/types";

/** Seed defaults (Iddo's profile) used until onboarding writes real values. */
const DEFAULT_GOALS = { calorieGoal: 1950, proteinGoal: 145, netCalorieBurnFactor: 50, stepGoal: 8000 };

export async function getUserGoals(
  uid: string,
): Promise<Pick<UserProfile, "calorieGoal" | "proteinGoal" | "netCalorieBurnFactor" | "stepGoal">> {
  const ref = doc(db, "users", uid, "meta", "profile");
  const snap = await getDoc(ref);
  const data = snap.data() as UserProfile | undefined;
  return {
    calorieGoal: data?.calorieGoal ?? DEFAULT_GOALS.calorieGoal,
    proteinGoal: data?.proteinGoal ?? DEFAULT_GOALS.proteinGoal,
    netCalorieBurnFactor: data?.netCalorieBurnFactor ?? DEFAULT_GOALS.netCalorieBurnFactor,
    stepGoal: data?.stepGoal ?? DEFAULT_GOALS.stepGoal,
  };
}
