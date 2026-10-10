import Progress from "./Progress";

// Per-user authenticated data — never statically prerendered.
export const dynamic = "force-dynamic";

export default function ProgressPage() {
  return <Progress />;
}
