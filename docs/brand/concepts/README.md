# טיוטות לוגו (ממתין לבחירה)

הלוגו הנוכחי באפליקציה (טבעת עם לב) **נפסל**. אלה הכיוונים החדשים:

- `options2.png`: ארבעה כיוונים (א׳ האות י׳, ב׳ קופת צדקה, ג׳ שיבולים, ד׳ עשרה מטבעות).
- `options3.png`: שילוב של ב׳ ו-ד׳ (E1–E3). יותר מדי פרטים לאייקון קטן.
- `options4.png`: כיוון מינימליסטי (F1 מטבע בקופה, F2 עשירית, F3 מ׳ + מטבע, F4 ⅒).

**המשתמש עדיין חושב.** הבריף המלא נמצא ב-[`../LOGO_BRIEF.md`](../LOGO_BRIEF.md).

קובצי ה-SVG כוללים גופן Heebo מוטמע. `generate-combined.js` מייצר אותם מחדש. הוא דורש את החבילה `@fontsource/heebo` בתיקייה `../fonts/node_modules`, ואת Playwright.

אחרי שהמשתמש בוחר, צריך לייצר מהלוגו הנבחר את כל הקבצים שהלוגו הנוכחי מייצר:
`public/icons/{logo.svg,icon-192.png,icon-512.png,maskable-512.png,apple-touch-icon.png}` ו-`docs/brand/{logo-wordmark.png,play-feature-graphic.png,icon-512.png,logo.svg}`.
את הטקסט ב-SVG כדאי להמיר לנתיבים, או לא להשתמש בטקסט, כדי שלא יהיה תלוי בגופן.
