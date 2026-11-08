# העלאה לאינטרנט (Fly.io)

האפליקציה ארוזה כ-Docker (`Dockerfile`) עם כרומיום, כך שאפשר להריץ אותה בכל שירות שתומך ב-Docker.
ההוראות כאן ל-Fly.io.

## דרישות
- חשבון ב-https://fly.io ו-[flyctl](https://fly.io/docs/flyctl/install/).
- Client ID של Google (ראו [GOOGLE_SETUP.md](GOOGLE_SETUP.md)). **בלי זה השרת לא יעלה ברשת** – כדי שאף אחד לא יגיע לנתונים בלי התחברות.

## שלבים
```bash
fly auth login
# בחרו שם פנוי ועדכנו אותו ב-fly.toml (app = "..." וגם PUBLIC_URL)
fly apps create maaser-me321
fly volumes create maaser_data --region fra --size 1 -a maaser-me321
fly secrets set -a maaser-me321 GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...
fly deploy -a maaser-me321
```
הכתובת תהיה `https://maaser-me321.fly.dev`. הוסיפו אותה ב-Google Cloud כ-Redirect URI:
`https://maaser-me321.fly.dev/auth/google/callback`.

### דומיין משלכם (לא חובה)
```bash
fly certs add maaser.example.com -a maaser-me321
```
ואז עדכנו את `PUBLIC_URL` ב-fly.toml ואת ה-Redirect URI ב-Google.

## עלויות (בערך)
מכונה עם 1GB זיכרון שרצה כל הזמן + דיסק 1GB: כ-6–7 דולר לחודש.

## חשוב לדעת
- **מיקום השרת**: אין ל-Fly אזור בישראל. חלק מהבנקים חוסמים או מבקשים אימות נוסף בהתחברות מחו"ל.
  אם בנק מסוים נכשל בשרת אבל עובד מקומית, אפשר להריץ את האפליקציה על שרת בישראל
  (למשל VPS ישראלי, או מחשב ביתי עם [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/))
  – אותו Dockerfile עובד בכל מקום.
- **הכספת נפתחת מחדש אחרי כל פריסה/הפעלה מחדש**: מפתחות הפענוח נשמרים רק בזיכרון, כך שאחרי עדכון
  כל משתמש יתבקש להזין שוב את סיסמת ההצפנה (וגם להתחבר שוב). זה מכוון, לטובת האבטחה.
- **גיבוי**: הנתונים נמצאים בדיסק `/data`. Fly שומר snapshot יומי של הדיסק כברירת מחדל.
