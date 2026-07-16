import Profile from "./Profile";

// Per-user authenticated data — never statically prerendered.
export const dynamic = "force-dynamic";

export default function ProfilePage() {
  return <Profile />;
}
