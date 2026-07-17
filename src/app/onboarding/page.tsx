import Onboarding from "./Onboarding";

// Per-user authenticated data — never statically prerendered.
export const dynamic = "force-dynamic";

export default function OnboardingPage() {
  return <Onboarding />;
}
