import NutritionLogger from "./NutritionLogger";

// Per-user authenticated data — never statically prerendered.
export const dynamic = "force-dynamic";

export default function Page() {
  return <NutritionLogger />;
}
