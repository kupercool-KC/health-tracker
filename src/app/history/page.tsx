import History from "./History";

// Per-user authenticated data — never statically prerendered.
export const dynamic = "force-dynamic";

export default function HistoryPage() {
  return <History />;
}
