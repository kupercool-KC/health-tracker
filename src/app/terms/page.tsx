import LegalPage, { SUPPORT_EMAIL } from "@/lib/legal/LegalPage";

export const metadata = { title: "Terms of use · תנאי שימוש" };

export default function TermsPage() {
  return (
    <LegalPage
      updated="2026-10-07"
      heTitle="תנאי שימוש"
      enTitle="Terms of use"
      he={[
        { title: "השירות", body: ["Health Tracker (\"לילי\") עוזר לכם לעקוב אחרי תזונה, פעילות ומדדי גוף ולקבל תמונה יומית, דרך אפליקציה, אתר ו-WhatsApp. השימוש בשירות מהווה הסכמה לתנאים אלה."] },
        { title: "לא ייעוץ רפואי", body: ["השירות נועד לאורח חיים בריא ולמידע כללי בלבד. לילי היא בינה מלאכותית, אינה דיאטנית, תזונאית או רופאה, ועלולה לטעות, בעיקר בהערכת קלוריות וערכים תזונתיים. אל תסתמכו עליה לצורך החלטות רפואיות."] },
        { title: "החשבון והשימוש", body: ["אתם אחראים לחשבון שלכם ולמידע שאתם מזינים. השירות מיועד לבני 18 ומעלה. אסור להשתמש בשירות באופן שפוגע בו, בספקיו או במשתמשים אחרים, או כדי לעקוף את מגבלותיו."] },
        { title: "מנוי ותשלום", body: ["ייתכן שחלק מהשירות יהיה בתשלום, בכפוף לתקופת ניסיון. מחירים, חידוש אוטומטי וביטול יוצגו בעת ההצטרפות. מנוי שנרכש דרך Apple מנוהל ומתבטל דרך הגדרות Apple ID."] },
        { title: "WhatsApp", body: ["השימוש בבוט ב-WhatsApp כפוף גם לתנאים של WhatsApp ו-Meta. אתם מסכימים לקבל הודעות מהשירות שביקשתם, וניתן להפסיק בכל עת."] },
        { title: "הגבלת אחריות", body: ["השירות ניתן כפי שהוא (AS IS). במידה המותרת בדין, איננו אחראים לנזקים עקיפים או תוצאתיים הנובעים משימוש בשירות או מהסתמכות על מידע שבו."] },
        { title: "סיום", body: ["אפשר למחוק את החשבון בכל עת (פרופיל ← מחיקת חשבון). אנחנו רשאים להשעות חשבון שמפר תנאים אלה."] },
        { title: "דין וסמכות שיפוט", body: ["על תנאים אלה יחול הדין הישראלי, ולבתי המשפט המוסמכים בישראל תהיה סמכות השיפוט הבלעדית."] },
        { title: "יצירת קשר", body: [SUPPORT_EMAIL] },
      ]}
      en={[
        { title: "The service", body: ["Health Tracker (\"Lilly\") helps you track nutrition, activity and body metrics and get a daily picture, through an app, a website and WhatsApp. By using it you agree to these terms."] },
        { title: "Not medical advice", body: ["The service is for healthy-lifestyle and general information only. Lilly is an AI, not a dietitian, nutritionist or doctor, and can make mistakes, especially when estimating calories and nutrition values. Do not rely on it for medical decisions."] },
        { title: "Your account and use", body: ["You are responsible for your account and the information you enter. The service is for people aged 18 and over. You may not use it in a way that harms it, its providers or other users, or to bypass its limits."] },
        { title: "Subscription and payment", body: ["Parts of the service may be paid, after a trial period. Prices, automatic renewal and cancellation are shown when you subscribe. A subscription bought through Apple is managed and cancelled in your Apple ID settings."] },
        { title: "WhatsApp", body: ["Using the bot on WhatsApp is also subject to WhatsApp's and Meta's terms. You agree to receive the messages from the service that you requested, and can stop at any time."] },
        { title: "Limitation of liability", body: ["The service is provided \"as is\". To the extent permitted by law, we are not liable for indirect or consequential damages arising from use of the service or reliance on information in it."] },
        { title: "Termination", body: ["You can delete your account at any time (Profile → Delete account). We may suspend an account that violates these terms."] },
        { title: "Governing law", body: ["These terms are governed by Israeli law, and the competent courts in Israel have exclusive jurisdiction."] },
        { title: "Contact", body: [SUPPORT_EMAIL] },
      ]}
    />
  );
}
