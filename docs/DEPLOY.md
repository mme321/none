# העלאה לענן (Fly.io + PostgreSQL)

## מה צריך
| | איפה |
|---|---|
| שרת | Fly.io (או כל שירות שמריץ Docker: Render, Railway, Google Cloud Run) |
| מסד נתונים | PostgreSQL 14+: Fly Managed Postgres, Neon, Supabase או Cloud SQL |
| התחברות | Google OAuth ([GOOGLE_SETUP.md](GOOGLE_SETUP.md)) |
| בנקים | Plaid ו/או Salt Edge ([BANKS.md](BANKS.md)) |

## שלבים ב-Fly.io
```bash
fly auth login
fly apps create maaser-me321          # שם פנוי; עדכנו גם ב-fly.toml

# מסד נתונים מנוהל (או: צרו ב-Neon/Supabase והעתיקו את ה-connection string)
fly mpg create --name maaser-db --region fra
fly mpg attach maaser-db -a maaser-me321    # מגדיר DATABASE_URL אוטומטית

fly secrets set -a maaser-me321 \
  ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
  PLAID_CLIENT_ID=... PLAID_SECRET=... \
  SALTEDGE_APP_ID=... SALTEDGE_SECRET=... SALTEDGE_CALLBACK_PUBLIC_KEY="..."

fly deploy -a maaser-me321
```
טבלאות המסד נוצרות אוטומטית בהפעלה הראשונה (מיגרציות).

**שמרו את `ENCRYPTION_KEY` גם במקום בטוח.** בלעדיו אי אפשר לפענח את טוקני הגישה לבנקים,
וכל המשתמשים יצטרכו לחבר את הבנקים מחדש.

## אחרי הפריסה
- ב-Google Cloud: Redirect URI `https://maaser-me321.fly.dev/auth/google/callback`
- ב-Plaid: Redirect URI `https://maaser-me321.fly.dev/plaid-oauth`
- ב-Salt Edge: כתובות ה-callbacks (ראו BANKS.md)
- בדיקה: `https://maaser-me321.fly.dev/healthz` צריך להחזיר `{"ok":true}`

## עלויות משוערות
- Fly: מכונה של 512MB שנכבית כשאין שימוש. כמה דולרים בחודש.
- Postgres מנוהל: מ-0$ (Neon/Supabase חינמי לפרויקט קטן) עד כ-40$ (Fly Managed Postgres).
- Plaid ו-Salt Edge: לפי מספר חיבורים. ראו בדשבורד של כל ספק.

## פיתוח מקומי
```bash
docker run -d --name pg -e POSTGRES_PASSWORD=pg -e POSTGRES_DB=maaser -p 5432:5432 postgres:16-alpine
cp .env.example .env    # ומלאו ENCRYPTION_KEY
npm install
npm run dev             # http://localhost:3000 (עם DEV_LOGIN=1 אפשר להיכנס בלי Google)
DATABASE_URL=postgres://postgres:pg@127.0.0.1:5432/maaser npm test
```
