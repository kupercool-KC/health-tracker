import Weight from "./Weight";

// Per-user authenticated data — never statically prerendered.
export const dynamic = "force-dynamic";

export default function WeightPage() {
  return <Weight />;
}
