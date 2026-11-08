# חיבור לבנקים – דרך API רשמי בלבד

האפליקציה **לא** מתחברת לאתרי הבנקים עם שם משתמש וסיסמה. היא עובדת מול ספקים מורשים שיש להם הסכמי API עם הבנקים:

| אזור | ספק | איך המשתמש מתחבר |
|---|---|---|
| 🇺🇸 ארה"ב (TD Bank ועוד) | [Plaid](https://plaid.com) | חלון Plaid Link. ב-TD Bank: מעבר לאתר/אפליקציית TD ואישור (OAuth) |
| 🇮🇱 ישראל (בנקים + כרטיסי אשראי) | [Salt Edge](https://www.saltedge.com) | חלון Salt Edge Connect: בחירת בנק ואישור גישה לפי תקן הבנקאות הפתוחה של בנק ישראל |

הספקים מוגדרים בשכבה נפרדת (`src/providers/`), כך שאפשר להוסיף או להחליף ספק (למשל Finanda בישראל) בלי לשנות את שאר האפליקציה.

---

## 🇺🇸 Plaid (TD Bank)

TD Bank חתם עם Plaid על הסכם גישה לנתונים דרך API, כך שהלקוח לא מוסר סיסמה לאף אחד.

### 1. פתיחת חשבון
1. נרשמים ב-https://dashboard.plaid.com/signup (מומלץ עם me321dev@gmail.com).
2. **Developers → Keys**: מעתיקים `client_id` ו-`Sandbox secret`.

### 2. הגדרות בדשבורד
- **Developers → API → Allowed redirect URIs**: מוסיפים `https://<הכתובת>/plaid-oauth`.
  זה נדרש לבנקים שעובדים ב-OAuth, ו-TD Bank הוא אחד מהם.
- את ה-webhook האפליקציה שולחת לבד (`https://<הכתובת>/webhooks/plaid`), ואין צורך להגדיר אותו בדשבורד.

### 3. משתני סביבה
```
PLAID_CLIENT_ID=...
PLAID_SECRET=...
PLAID_ENV=sandbox          # אחר כך: production
PLAID_REDIRECT_URI=https://<הכתובת>/plaid-oauth
```

### 4. בדיקה ב-Sandbox
ב-Sandbox אין כסף אמיתי. בחלון Plaid בוחרים בנק כלשהו ומתחברים עם `user_good` / `pass_good`
(או `user_transactions_dynamic` לתנועות שמשתנות).

### 5. מעבר לייצור (בנקים אמיתיים)
- בדשבורד: **Request production access**. ממלאים פרופיל חברה ושאלון אבטחה.
- **OAuth institutions**: לבנקים גדולים כמו TD צריך גם לבקש גישת OAuth.
  זה מופיע בדשבורד תחת "OAuth institutions" ולוקח בדרך כלל כמה ימים עד שבועות.
- התמחור לפי מספר החיבורים. יש מסלול Pay-as-you-go. המחיר המעודכן מופיע בדשבורד.

---

## 🇮🇱 Salt Edge (ישראל)

בישראל הגישה לנתוני בנקים לפי חוק שירות מידע פיננסי ותקן הבנקאות הפתוחה של בנק ישראל ניתנת רק לגופים
**בעלי רישיון מרשות ניירות ערך**, או דרך ספק מורשה. Salt Edge מציע גישה לחשבונות (AIS)
גם לאפליקציות בלי רישיון עצמאי, תחת המסגרת שלו.

> ⚠️ **לבדוק מולם לפני שמתחילים**: אילו בנקים וחברות אשראי בישראל זמינים בפועל, תנאי ההתקשרות, והאם
> נדרש רישיון או הסכם. אם התנאים לא מתאימים, החלופות הן **Finanda** (בעלת רישיון רשות ניירות ערך)
> או **FinTeka** (של לאומי). את שתיהן אפשר להוסיף כספק נוסף ב-`src/providers/`.

### 1. פתיחת חשבון
1. נרשמים ב-https://www.saltedge.com/client_users/sign_up.
2. בדשבורד: **API Keys** → יוצרים מפתח (App ID + Secret).
3. חשבון חדש נמצא במצב **Pending**, עם גישה לבנקים מדומים (Fake providers) לבדיקה.
4. כדי לקבל בנקים אמיתיים: **Request Live** / פנייה לצוות Salt Edge.

### 2. Callbacks
בדשבורד → **Callbacks** מגדירים:
- Success: `https://<הכתובת>/webhooks/saltedge/success`
- Fail: `https://<הכתובת>/webhooks/saltedge/fail`
- Destroy: `https://<הכתובת>/webhooks/saltedge/destroy`
- Notify: `https://<הכתובת>/webhooks/saltedge/notify`

את **המפתח הציבורי של Salt Edge לאימות callbacks** (מופיע בתיעוד שלהם, בפרק Callbacks → Signature)
שמים ב-`SALTEDGE_CALLBACK_PUBLIC_KEY`. בלי המפתח, callbacks נדחים, חוץ ממצב sandbox.

### 3. משתני סביבה
```
SALTEDGE_APP_ID=...
SALTEDGE_SECRET=...
SALTEDGE_SANDBOX=1                        # מציג גם בנקים מדומים. להסיר בייצור
SALTEDGE_CALLBACK_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n..."
SALTEDGE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."   # נדרש במצב Live (חתימת בקשות)
```
במצב Live, Salt Edge דורש שכל בקשה תהיה חתומה. יוצרים זוג מפתחות
(`openssl genrsa -out private.pem 2048 && openssl rsa -in private.pem -pubout -out public.pem`),
מעלים את `public.pem` לדשבורד, ואת `private.pem` שמים ב-`SALTEDGE_PRIVATE_KEY`.

---

## איך הנתונים זורמים
1. המשתמש לוחץ "חיבור בנק" ומאשר בחלון של הספק.
2. השרת מקבל מזהה חיבור. אצל Plaid זה גם access token, שנשמר **מוצפן** (AES-256-GCM עם `ENCRYPTION_KEY`).
3. התנועות נמשכות מיד ונשמרות ב-Postgres.
4. עדכונים בהמשך: Plaid שולח webhook כשיש תנועות חדשות, ו-Salt Edge מרענן אוטומטית ושולח callback.
   בנוסף, השרת מריץ סנכרון גיבוי כל 6 שעות (`SYNC_INTERVAL_HOURS`).
5. כל webhook נבדק בחתימה קריפטוגרפית: JWT ES256 אצל Plaid, RSA אצל Salt Edge.
6. ניתוק חיבור מבטל את הגישה גם אצל הספק.
