import Today from "./Today";

// Per-user authenticated data — never statically prerendered.
export const dynamic = "force-dynamic";

export default function TodayPage() {
  return <Today />;
}
