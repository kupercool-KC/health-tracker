import LegalPage, { SUPPORT_EMAIL } from "@/lib/legal/LegalPage";

export const metadata = { title: "Privacy policy · מדיניות פרטיות" };

export default function PrivacyPage() {
  return (
    <LegalPage
      updated="2026-10-08"
      heTitle="מדיניות פרטיות"
      enTitle="Privacy policy"
      he={[
        { title: "מי אנחנו", body: ["Health Tracker (\"לילי\") הוא שירות למעקב תזונה, פעילות ובריאות, דרך אפליקציה, אתר ו-WhatsApp. לשאלות פרטיות: " + SUPPORT_EMAIL] },
        { title: "איזה מידע אנחנו אוספים", body: ["פרטי חשבון: שם וכתובת מייל (מהתחברות Google או Apple).", "מידע שאתם מזינים: ארוחות, אימונים, צעדים, משקל ומדדי גוף, יעדים, העדפות תזונה ואלרגיות, והודעות הצ'אט עם לילי (כולל תמלול של הודעות קוליות).", "תמונות שאתם שולחים (ארוחות, צילומי מסך של אימון או צעדים).", "מספר ה-WhatsApp שקישרתם, וחיבור לנתוני Apple Health אם בחרתם להפעיל.", "מידע טכני בסיסי (יומני שגיאות)."] },
        { title: "מידע בריאותי", body: ["חלק מהמידע הוא מידע על בריאות. אנחנו משתמשים בו רק כדי לתת לכם את השירות, ולא נמכור אותו ולא נשתמש בו לפרסום."] },
        { title: "למה אנחנו משתמשים במידע", body: ["כדי לתעד, לחשב ולהציג את הנתונים שלכם, לענות לכם בצ'אט, לשלוח תזכורות וסיכומים שביקשתם, ולשפר את איכות השירות ואת האבטחה."] },
        { title: "מי מעבד את המידע", body: ["ספקים שמעבדים מידע בשמנו: Google Firebase (אחסון והתחברות), Vercel (אירוח), OpenAI (עיבוד הודעות, תמונות והקלטות כדי להבין ולענות), Meta (שליחת וקבלת הודעות WhatsApp), ומקורות מידע תזונתיים ציבוריים לחיפוש ערכים.", "המידע נשלח לספקים אלה רק לצורך מתן השירות. איננו מוכרים מידע אישי."] },
        { title: "עיבוד בינה מלאכותית והסכמה", body: ["כדי לענות לכם, ההודעות, התמונות, ההקלטות והנתונים הבריאותיים שאתם מזינים נשלחים לעיבוד אצל OpenAI (ארה\"ב). זה קורה רק אחרי שאישרתם זאת במסך ההסכמה, וניתן לסרב. בלי הסכמה אי אפשר להשתמש ביכולות הבינה המלאכותית של לילי.", "OpenAI מצהירה שנתונים שנשלחים דרך ה-API שלה אינם משמשים לאימון המודלים שלה כברירת מחדל, ועשויים להישמר עד 30 יום לצורך זיהוי שימוש לרעה. אנחנו לא שולחים ל-OpenAI את כתובת המייל ואת מספר הטלפון שלכם. השם שהזנתם בפרופיל נשלח כדי שלילי תפנה אליכם.", "אתם יכולים לסגת מההסכמה בכל רגע על ידי מחיקת החשבון (פרופיל ← מחיקת חשבון)."] },
        { title: "העברת מידע מחוץ לישראל", body: ["הספקים שמפורטים למעלה פועלים גם מחוץ לישראל, בעיקר בארה\"ב. אנחנו מעבירים אליהם מידע רק לצורך מתן השירות."] },
        { title: "WhatsApp", body: ["אם קישרתם WhatsApp, ההודעות שלכם עוברות דרך Meta בהתאם לתנאים ולמדיניות הפרטיות שלה. הקישור אופציונלי ואפשר לנתק אותו בכל רגע (פרופיל ← בטל קישור). אנחנו שולחים הודעות יזומות (תזכורות וסיכומים) רק אם הפעלתם אותן."] },
        { title: "מי אחראי על המידע", body: ["המפעיל: עידו קופרמן, ישראל, יחיד. ליצירת קשר: " + SUPPORT_EMAIL, "תלונה על הטיפול במידע אפשר להגיש גם לרשות להגנת הפרטיות בישראל."] },
        { title: "כמה זמן אנחנו שומרים", body: ["עד שתמחקו את החשבון. מחיקת חשבון (פרופיל ← מחיקת חשבון) מוחקת את החשבון ואת כל הנתונים, התמונות והשיחות. קישורים ציבוריים לשיחה ששיתפתם עשויים להישאר זמינים למי שמחזיק בקישור."] },
        { title: "הזכויות שלכם", body: ["אתם רשאים לעיין במידע, לתקן אותו ולמחוק אותו. רוב הפעולות זמינות ישירות באפליקציה. לבקשות נוספות: " + SUPPORT_EMAIL] },
        { title: "אבטחה", body: ["אנחנו משתמשים באחסון מוצפן ובהרשאות גישה לכל משתמש בנפרד. אף מערכת אינה חסינה לחלוטין."] },
        { title: "גיל", body: ["השירות מיועד לבני 18 ומעלה."] },
        { title: "לא ייעוץ רפואי", body: ["לילי אינה דיאטנית, תזונאית או רופאה, והמידע אינו מהווה ייעוץ רפואי. התייעצו עם איש מקצוע לפני שינוי משמעותי בתזונה או בפעילות, במיוחד אם יש לכם מצב רפואי."] },
        { title: "שינויים", body: ["נעדכן מדיניות זו מעת לעת, והתאריך שבראש העמוד יתעדכן."] },
      ]}
      en={[
        { title: "Who we are", body: ["Health Tracker (\"Lilly\") is a nutrition, activity and health tracking service available as an app, a website and on WhatsApp. Privacy questions: " + SUPPORT_EMAIL] },
        { title: "What we collect", body: ["Account details: name and email (from Google or Apple sign-in).", "What you enter: meals, workouts, steps, weight and body metrics, goals, dietary preferences and allergies, and your chat messages with Lilly (including transcripts of voice notes).", "Photos you send (meals, workout or steps screenshots).", "The WhatsApp number you link, and Apple Health data if you choose to connect it.", "Basic technical information (error logs)."] },
        { title: "Health information", body: ["Some of this information relates to your health. We use it only to provide the service. We do not sell it and do not use it for advertising."] },
        { title: "How we use it", body: ["To record, calculate and show your data, answer you in chat, send the reminders and summaries you asked for, and to improve quality and security."] },
        { title: "Who processes it", body: ["Providers that process data on our behalf: Google Firebase (storage and sign-in), Vercel (hosting), OpenAI (processing messages, photos and recordings to understand and reply), Meta (sending and receiving WhatsApp messages), and public nutrition data sources for lookups.", "Data is sent to these providers only to deliver the service. We do not sell personal data."] },
        { title: "AI processing and consent", body: ["To answer you, the messages, photos, voice recordings and health entries you submit are sent to OpenAI (USA) for processing. This happens only after you agree on the consent screen, and you can say no. Without consent you can't use Lilly's AI features.", "OpenAI states that data sent through its API is not used to train its models by default and may be kept for up to 30 days for abuse monitoring. We do not send OpenAI your email address or phone number. The name you entered in your profile is sent so Lilly can address you.", "You can withdraw consent at any time by deleting your account (Profile → Delete account)."] },
        { title: "Transfers outside Israel", body: ["The providers listed above also operate outside Israel, mainly in the USA. We send them data only to deliver the service."] },
        { title: "WhatsApp", body: ["If you link WhatsApp, your messages pass through Meta under its own terms and privacy policy. Linking is optional and you can unlink at any time (Profile → Unlink). We send proactive messages (reminders and summaries) only if you turned them on."] },
        { title: "Who is responsible for the data", body: ["Operator: Iddo Kuperman, Israel, an individual. Contact: " + SUPPORT_EMAIL, "You may also complain about how data is handled to the Privacy Protection Authority in Israel."] },
        { title: "How long we keep it", body: ["Until you delete your account. Deleting your account (Profile → Delete account) removes the account and all your data, photos and chats. Public links to a chat you shared may remain accessible to anyone holding the link."] },
        { title: "Your rights", body: ["You may access, correct and delete your data. Most of this is available directly in the app. For other requests: " + SUPPORT_EMAIL] },
        { title: "Security", body: ["We use encrypted storage and per-user access controls. No system is completely secure."] },
        { title: "Age", body: ["The service is intended for people aged 18 and over."] },
        { title: "Not medical advice", body: ["Lilly is not a dietitian, nutritionist or doctor, and nothing here is medical advice. Consult a professional before making major changes to your diet or exercise, especially if you have a medical condition."] },
        { title: "Changes", body: ["We may update this policy from time to time and will change the date at the top."] },
      ]}
    />
  );
}
