import Settings from "./Settings";

// Per-user authenticated data — never statically prerendered.
export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return <Settings />;
}
