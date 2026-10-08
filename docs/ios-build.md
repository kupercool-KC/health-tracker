# בניית אפליקציית ה-iOS

הפרויקט נוצר עם Capacitor (תיקיית `ios/`, בלי CocoaPods, עם Swift Package Manager). האפליקציה טוענת את האתר החי (`capacitor.config.ts` ← `server.url`) ועוטפת אותו, והתחברות Google ו-Apple נעשית נייטיב.

## מה שנשאר לעשות אצל בעל החשבון / ב-Xcode (פעם אחת)
1. **שם ו-Bundle ID סופיים:** ב-`capacitor.config.ts` (`appId`, `appName`), ואז `npx cap sync ios`.
2. **Xcode** ← פתיחת `ios/App/App.xcodeproj` ← Target "App" ← **Signing & Capabilities**:
   - Team: הצוות של החבר.
   - **+ Capability** ← **Sign in with Apple**.
3. **Firebase** (console.firebase.google.com ← health-tracker-new ← Project settings ← Add app ← iOS):
   - Bundle ID זהה. הורדת `GoogleService-Info.plist` ← גרירה לתוך `ios/App/App` ב-Xcode.
   - Authentication ← Sign-in method ← הפעלת **Apple**.
   - הוספת ה-`REVERSED_CLIENT_ID` מהקובץ כ-URL Scheme (Target ← Info ← URL Types).
4. **אייקון:** תמונה 1024×1024 אל `ios/App/App/Assets.xcassets/AppIcon.appiconset`.
5. הרצה בסימולטור (▶), ואז Product ← Archive ← Distribute App ← App Store Connect.
