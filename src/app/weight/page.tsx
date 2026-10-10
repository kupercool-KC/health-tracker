import { redirect } from "next/navigation";

// The Weight tab became Progress (weigh-ins live inside it).
export default function WeightPage() {
  redirect("/progress");
}
