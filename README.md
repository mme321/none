# מחשבון מעשר 🪙

אפליקציית ענן לחישוב **מעשר וחומש**. היא מתחברת לחשבונות הבנק וכרטיסי האשראי **בישראל ובארה"ב** דרך API רשמי,
מזהה הכנסות ותרומות, ומראה כמה נשאר לתת.

## יכולות
- **חיבור לבנקים דרך API רשמי בלבד**, בלי סיסמאות לבנק ובלי גרידת אתרים:
  - 🇺🇸 **ארה"ב: TD Bank** ואלפי בנקים נוספים, דרך **Plaid**
  - 🇮🇱 **ישראל**: בנקים וכרטיסי אשראי לפי תקן הבנקאות הפתוחה של בנק ישראל, דרך ספק מורשה (**Salt Edge**)
- **עדכון אוטומטי**: webhooks מהספקים, וסנכרון גיבוי תקופתי.
- **שקלים ודולרים**: כל תנועה מומרת למטבע החישוב לפי שער היום שלה, ומוצג גם פירוט לפי מטבע מקורי.
- **סיווג אוטומטי** (משכורת = הכנסה, "תרומה" / "צדקה" / "Charity" = תרומה, העברות בין חשבונות = לא נספר),
  כללים שאפשר לערוך, ושינוי ידני לכל תנועה.
- **מעשר וחומש**: חישוב עיקרי של 10% או 20%, עם אפשרות להציג את החומש לצד המעשר. פירוט חודשי עם יתרה מצטברת.
- **התחברות עם Google**. כל משתמש רואה רק את הנתונים שלו.
- **PostgreSQL** בענן. טוקני גישה לבנקים מוצפנים במנוחה.
- **אפליקציה לטלפון** (PWA), מוכנה לפרסום ב-Google Play.

## מבנה
```
server.js              שרת Express: API, webhooks, התחברות
src/db.js              PostgreSQL + מיגרציות
src/auth.js            Google OAuth + סשנים במסד
src/providers/plaid.js     Plaid (ארה"ב)
src/providers/saltedge.js  Salt Edge (ישראל)
src/service.js         סנכרון חיבורים ותנועות
src/fx.js              שערי חליפין (ECB)
src/classify.js        סיווג תנועות
src/calc.js            חישוב מעשר/חומש
public/                ממשק (עברית, RTL, מותאם לטלפון)
```

## הקמה
1. **Google login**: [docs/GOOGLE_SETUP.md](docs/GOOGLE_SETUP.md) (תחת המשתמש me321dev)
2. **ספקי בנקים** (Plaid, Salt Edge): [docs/BANKS.md](docs/BANKS.md)
3. **פריסה לענן**: [docs/DEPLOY.md](docs/DEPLOY.md)
4. **פרסום בחנויות**: [docs/STORE.md](docs/STORE.md)

## משתני סביבה
| משתנה | חובה | תיאור |
|---|---|---|
| `DATABASE_URL` | ✔ | PostgreSQL |
| `ENCRYPTION_KEY` | ✔ | 32 בתים ב-base64 (`openssl rand -base64 32`). מצפין טוקני גישה |
| `PUBLIC_URL` | ✔ | הכתובת הציבורית, למשל `https://maaser.example.com` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | ✔ | התחברות |
| `ALLOWED_EMAILS` | | הגבלת ההתחברות למיילים מסוימים |
| `PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV` / `PLAID_REDIRECT_URI` | | בנקים בארה"ב |
| `SALTEDGE_APP_ID` / `SALTEDGE_SECRET` / `SALTEDGE_CALLBACK_PUBLIC_KEY` / `SALTEDGE_PRIVATE_KEY` / `SALTEDGE_SANDBOX` | | בנקים בישראל |
| `SYNC_INTERVAL_HOURS` | | סנכרון גיבוי (ברירת מחדל 6) |
| `ANDROID_PACKAGE_NAME` / `ANDROID_CERT_SHA256` | | אפליקציית Google Play |
| `DEV_LOGIN=1` | | כניסה בלי Google, **לפיתוח בלבד** (חסום כש-`NODE_ENV=production`) |

## אבטחה
- אין סיסמאות לבנקים. החיבור נעשה בחלון של הספק/הבנק, והאפליקציה מקבלת הרשאת קריאה בלבד שאפשר לבטל.
- טוקני גישה מוצפנים ב-AES-256-GCM. סשנים נשמרים במסד כ-hash.
- Webhooks נבדקים בחתימה קריפטוגרפית (Plaid: JWT ES256, Salt Edge: RSA).
- עוגיות HttpOnly/Secure/SameSite, בדיקת state ב-OAuth, והגנת CSRF.
- כל שאילתה מסוננת לפי המשתמש המחובר. יש בדיקת אינטגרציה שמוודאת שמשתמש אחד לא יכול לגשת לנתונים של אחר.

## בדיקות
```bash
DATABASE_URL=postgres://... npm test
```
בדיקת האינטגרציה רצה מול Postgres אמיתי ושרתים מדומים של Plaid ו-Salt Edge.

## הערה
האפליקציה היא כלי עזר לחישוב. בשאלות הלכתיות (ברוטו או נטו, מה נחשב הכנסה, למי מותר לתת מכספי מעשר) כדאי להתייעץ עם רב.
