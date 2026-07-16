import Dashboard from "./Dashboard";

// Per-user authenticated data — never statically prerendered.
export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return <Dashboard />;
}
