import Admin from "./Admin";

// Per-user authenticated data — never statically prerendered.
export const dynamic = "force-dynamic";

export default function AdminPage() {
  return <Admin />;
}
