import LegalPage, { SUPPORT_EMAIL } from "@/lib/legal/LegalPage";

export const metadata = { title: "Support · תמיכה" };

export default function SupportPage() {
  return (
    <LegalPage
      updated="2026-10-08"
      heTitle="תמיכה"
      enTitle="Support"
      he={[
        { title: "איך יוצרים קשר", body: ["מייל: " + SUPPORT_EMAIL, "אנחנו עונים בדרך כלל תוך יומיים עסקים. כתבו מה קרה, באיזה מכשיר (אייפון או אתר) ומתי, ואם אפשר צרפו צילום מסך.", "לילי מופעלת על ידי יחיד בישראל. פרטי המפעיל והמידע על הטיפול בנתונים נמצאים במדיניות הפרטיות."] },
        { title: "מחיקת חשבון ונתונים", body: ["באפליקציה: פרופיל, למטה, \"מחק את החשבון שלי\". זה מוחק לצמיתות את החשבון, הארוחות, האימונים, השיחות והתמונות.", "אם אין לכם גישה לאפליקציה, שלחו מייל מהכתובת שאיתה נרשמתם ונמחק עבורכם."] },
        { title: "קישור ווצאפ", body: ["בפרופיל לוחצים \"קבל קוד קישור\" ושולחים את הקוד לבוט מהמספר שרוצים לקשר. הקוד תקף ל-15 דקות.", "לניתוק: פרופיל ← \"בטל קישור\". אפשר להפסיק להשתמש בווצאפ בכל רגע, והאפליקציה ממשיכה לעבוד."] },
        { title: "מנויים וביטול", body: ["בגרסה הנוכחית השימוש חינם. כשיהיו מנויים, מחיר, תקופת ניסיון והחידוש האוטומטי יוצגו לפני ההצטרפות, ומנוי שנרכש דרך Apple מתבטל בהגדרות, תחת Apple ID ← מנויים."] },
        { title: "הערכות קלוריות לא מדויקות", body: ["לילי היא בינה מלאכותית והערכות קלוריות וחלבון עלולות לטעות. אפשר לתקן בהודעה (\"זה היה 300\") או לבקש למחוק רשומה. כשיש ערכים מהאריזה, שלחו אותם ולילי תשתמש בהם."] },
        { title: "בעיות נפוצות", body: ["לא מתקבלות הודעות בווצאפ: ודאו שהמספר מקושר בפרופיל, ושלא עברו 24 שעות מההודעה האחרונה שלכם.", "הקלטה קולית לא מובנת: דברו קרוב, או כתבו. הודעות קוליות מתומללות אוטומטית.", "משהו אחר: שלחו מייל."] },
        { title: "מידע חשוב", body: ["לילי אינה דיאטנית, תזונאית או רופאה, ואינה מחליפה ייעוץ מקצועי. אם יש לכם הפרעת אכילה או מצב רפואי, פנו לאיש מקצוע. במצב חירום פנו למוקד 101 או לעמותת ער\"ן בטלפון 1201."] },
        { title: "מסמכים", body: ["מדיניות פרטיות: /privacy", "תנאי שימוש: /terms"] },
      ]}
      en={[
        { title: "How to reach us", body: ["Email: " + SUPPORT_EMAIL, "We usually reply within two business days. Tell us what happened, on which device (iPhone or web) and when, and attach a screenshot if you can.", "Lilly is operated by an individual in Israel. Operator details and how data is handled are in the Privacy policy."] },
        { title: "Deleting your account and data", body: ["In the app: Profile, at the bottom, \"Delete my account\". This permanently deletes your account, meals, workouts, chats and photos.", "If you can't open the app, email us from the address you signed up with and we'll delete it for you."] },
        { title: "Linking WhatsApp", body: ["In Profile tap \"Get a link code\" and send the code to the bot from the number you want to link. The code is valid for 15 minutes.", "To unlink: Profile → \"Unlink\". You can stop using WhatsApp any time and the app keeps working."] },
        { title: "Subscriptions and cancelling", body: ["The current version is free. When subscriptions arrive, the price, trial length and automatic renewal are shown before you subscribe, and a subscription bought through Apple is cancelled in Settings → Apple ID → Subscriptions."] },
        { title: "Inaccurate calorie estimates", body: ["Lilly is an AI and calorie or protein estimates can be wrong. Correct it in a message (\"it was 300\") or ask to delete an entry. If you have the numbers from the package, send them and Lilly will use them."] },
        { title: "Common problems", body: ["No WhatsApp replies: check the number is linked in Profile and that 24 hours haven't passed since your last message.", "Voice note misunderstood: speak closer to the phone, or type. Voice notes are transcribed automatically.", "Anything else: email us."] },
        { title: "Important", body: ["Lilly is not a dietitian, nutritionist or doctor and does not replace professional advice. If you have an eating disorder or a medical condition, please talk to a professional. In an emergency call your local emergency number."] },
        { title: "Documents", body: ["Privacy policy: /privacy", "Terms of use: /terms"] },
      ]}
    />
  );
}
