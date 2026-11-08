# הגדרת התחברות עם Google (בחשבון me321dev)

את כל השלבים מבצעים כשאתם מחוברים לחשבון Google **me321dev**.
כך הפרויקט ב-Google Cloud, מסך ההסכמה, והחשבון בחנות Google Play יהיו כולם תחת אותו משתמש.

> טיפ: פתחו חלון גלישה בסתר (או פרופיל Chrome נפרד) והתחברו רק ל-me321dev, כדי שהפרויקט לא ייווצר בטעות בחשבון אחר.

## 1. יצירת פרויקט
1. היכנסו ל-https://console.cloud.google.com ובדקו בפינה השמאלית העליונה שהחשבון הוא me321dev.
2. בתפריט הפרויקטים (למעלה) ← **New Project** ← שם: `maaser` ← **Create**.
3. ודאו שהפרויקט החדש נבחר.

## 2. מסך הסכמה (OAuth consent screen / Google Auth Platform)
1. תפריט ← **APIs & Services** ← **OAuth consent screen** (בממשק החדש: **Google Auth Platform** ← **Branding**).
2. **App name**: מחשבון מעשר. **User support email**: me321dev@gmail.com.
3. **Audience**: **External**.
4. **Contact email**: me321dev@gmail.com.
5. בלשונית **Branding** הוסיפו:
   - App home page: `https://<הכתובת שלכם>/`
   - Privacy policy: `https://<הכתובת שלכם>/privacy.html`
   - Authorized domains: הדומיין (למשל `maaser.fly.dev` או הדומיין שלכם)
6. **Data access / Scopes**: רק `openid`, `email`, `profile` (אין צורך בהרשאות רגישות, ולכן אין צורך באימות מ-Google).
7. **Audience** ← **Publish app** (מעבר ל-In production), אחרת רק "Test users" יוכלו להתחבר.

## 3. יצירת Client ID
1. **APIs & Services** ← **Credentials** ← **Create credentials** ← **OAuth client ID**.
2. Application type: **Web application**. Name: `maaser-web`.
3. **Authorized redirect URIs** – הוסיפו:
   - `https://<הכתובת שלכם>/auth/google/callback`
   - `http://localhost:3000/auth/google/callback` (לפיתוח מקומי, לא חובה)
4. **Create**. שמרו את ה-**Client ID** ואת ה-**Client secret**.

## 4. הגדרה בשרת
משתני סביבה:

| משתנה | ערך |
|---|---|
| `GOOGLE_CLIENT_ID` | ה-Client ID |
| `GOOGLE_CLIENT_SECRET` | ה-Client secret (**סוד** – לא לשים בקוד או ב-git) |
| `PUBLIC_URL` | הכתובת המלאה, למשל `https://maaser.fly.dev` |
| `ALLOWED_EMAILS` | (לא חובה) רשימת מיילים מופרדת בפסיקים שמותר להם להתחבר. ריק = כל אחד |

ב-Fly.io:
```bash
fly secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...
```

לבדיקה מקומית:
```bash
cp .env.example .env   # מלאו GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
npm run dev
```
