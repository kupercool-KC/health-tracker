/**
 * GET /api/admin/approve-pr?token=<ADMIN_REVIEW_SECRET>&pr=<number>
 *
 * One-click merge for a PR opened by the weekly WhatsApp-review cloud agent
 * (see /api/admin/whatsapp-review) when it finds and fixes a bug. Clicked
 * from a link in the weekly report email — merges the PR into `dev`, never
 * `main`, so a production deploy still requires the usual manual "push to
 * prod" step. Not linked from any UI; token-gated like the review endpoint.
 * Returns an HTML page (not JSON) since it's meant to be opened directly
 * from an email client.
 */
import { NextResponse } from "next/server";

const OWNER = "kupercool-KC";
const REPO = "health-tracker";

function page(title: string, body: string, status = 200): NextResponse {
  return new NextResponse(
    `<!DOCTYPE html><html dir="ltr"><head><meta charset="utf-8"><title>${title}</title>
    <style>body{font-family:Arial,sans-serif;max-width:560px;margin:64px auto;padding:0 16px;color:#1a1a1a}</style>
    </head><body><h2>${title}</h2><p>${body}</p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const prNumber = url.searchParams.get("pr");

  if (!token || !process.env.ADMIN_REVIEW_SECRET || token !== process.env.ADMIN_REVIEW_SECRET) {
    return page("לא מורשה", "הקישור הזה לא תקין או שפג תוקפו.", 401);
  }
  if (!prNumber || !/^\d+$/.test(prNumber)) {
    return page("שגיאה", "מספר PR חסר או לא תקין.", 400);
  }

  const ghToken = process.env.GITHUB_MERGE_TOKEN;
  if (!ghToken) {
    return page("שגיאת הגדרה", "GITHUB_MERGE_TOKEN לא מוגדר בשרת.", 500);
  }

  const ghHeaders = {
    Authorization: `Bearer ${ghToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const prRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/pulls/${prNumber}`, { headers: ghHeaders });
  if (!prRes.ok) {
    return page("שגיאה", `לא הצלחתי למצוא PR מספר ${prNumber} (${prRes.status}).`, 404);
  }
  const pr = (await prRes.json()) as { state: string; merged: boolean; base: { ref: string }; html_url: string; title: string };

  if (pr.merged) {
    return page("כבר מוזג", `PR #${prNumber} (${pr.title}) כבר היה ממוזג קודם.`);
  }
  if (pr.state !== "open") {
    return page("שגיאה", `PR #${prNumber} סגור ולא ממוזג — אין מה למזג.`, 409);
  }
  if (pr.base.ref !== "dev") {
    return page("שגיאה", `הקישור הזה ממזג רק ל-dev, וה-PR הזה מיועד ל-${pr.base.ref}. מזג ידנית ב-GitHub.`, 409);
  }

  const mergeRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/pulls/${prNumber}/merge`, {
    method: "PUT",
    headers: { ...ghHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ merge_method: "squash" }),
  });

  if (!mergeRes.ok) {
    const detail = await mergeRes.text().catch(() => "");
    return page("המיזוג נכשל", `GitHub החזיר שגיאה (${mergeRes.status}): ${detail}`, 502);
  }

  return page(
    "✅ מוזג ל-dev",
    `PR #${prNumber} (${pr.title}) מוזג בהצלחה ל-dev. בדוק בדפדפן שהתיקון עובד, ותגיד לי כשתרצה לדחוף לפרודקשן.<br><br><a href="${pr.html_url}">צפה ב-PR</a>`,
  );
}
