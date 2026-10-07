import type { ReactNode } from "react";

export interface LegalSection {
  title: string;
  body: string[];
}

/** Public, logged-out legal page — shows Hebrew and English one after the other. */
export default function LegalPage({ he, en, heTitle, enTitle, updated }: { he: LegalSection[]; en: LegalSection[]; heTitle: string; enTitle: string; updated: string }) {
  const render = (sections: LegalSection[]): ReactNode =>
    sections.map((s) => (
      <section key={s.title} style={{ marginTop: 20 }}>
        <h2 style={{ fontSize: 17, margin: "0 0 6px" }}>{s.title}</h2>
        {s.body.map((p) => (
          <p key={p} style={{ margin: "0 0 8px", lineHeight: 1.6 }}>
            {p}
          </p>
        ))}
      </section>
    ));
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "24px 16px 64px" }}>
      <div dir="rtl" lang="he">
        <h1 style={{ fontSize: 24 }}>{heTitle}</h1>
        <p style={{ color: "var(--muted)", fontSize: 13 }}>עודכן לאחרונה: {updated}</p>
        {render(he)}
      </div>
      <hr style={{ margin: "40px 0", opacity: 0.3 }} />
      <div dir="ltr" lang="en">
        <h1 style={{ fontSize: 24 }}>{enTitle}</h1>
        <p style={{ color: "var(--muted)", fontSize: 13 }}>Last updated: {updated}</p>
        {render(en)}
      </div>
    </main>
  );
}

export const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "(support address to be added)";
