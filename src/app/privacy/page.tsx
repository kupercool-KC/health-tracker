import LegalPage, { SUPPORT_EMAIL } from "@/lib/legal/LegalPage";

export const metadata = { title: "Privacy policy · מדיניות פרטיות" };

export default function PrivacyPage() {
  return (
    <LegalPage
      updated="2026-10-07"
      heTitle="מדיניות פרטיות"
      enTitle="Privacy policy"
      he={[
        { title: "מי אנחנו", body: ["Health Tracker (\"לילי\") הוא שירות למעקב תזונה, פעילות ובריאות, דרך אפליקציה, אתר ו-WhatsApp. לשאלות פרטיות: " + SUPPORT_EMAIL] },
        { title: "איזה מידע אנחנו אוספים", body: ["פרטי חשבון: שם וכתובת מייל (מהתחברות Google או Apple).", "מידע שאתם מזינים: ארוחות, אימונים, צעדים, משקל ומדדי גוף, יעדים, העדפות תזונה ואלרגיות, והודעות הצ'אט עם לילי (כולל תמלול של הודעות קוליות).", "תמונות שאתם שולחים (ארוחות, צילומי מסך של אימון או צעדים).", "מספר ה-WhatsApp שקישרתם, וחיבור לנתוני Apple Health אם בחרתם להפעיל.", "מידע טכני בסיסי (יומני שגיאות)."] },
        { title: "מידע בריאותי", body: ["חלק מהמידע הוא מידע על בריאות. אנחנו משתמשים בו רק כדי לתת לכם את השירות, ולא נמכור אותו ולא נשתמש בו לפרסום."] },
        { title: "למה אנחנו משתמשים במידע", body: ["כדי לתעד, לחשב ולהציג את הנתונים שלכם, לענות לכם בצ'אט, לשלוח תזכורות וסיכומים שביקשתם, ולשפר את איכות השירות ואת האבטחה."] },
        { title: "מי מעבד את המידע", body: ["ספקים שמעבדים מידע בשמנו: Google Firebase (אחסון והתחברות), Vercel (אירוח), OpenAI (עיבוד הודעות, תמונות והקלטות כדי להבין ולענות), Meta (שליחת וקבלת הודעות WhatsApp), ומקורות מידע תזונתיים ציבוריים לחיפוש ערכים.", "המידע נשלח לספקים אלה רק לצורך מתן השירות. איננו מוכרים מידע אישי."] },
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
