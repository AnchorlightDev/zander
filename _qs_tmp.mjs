import { quickshopDb } from "./controllers/databaseController.js";
const q=(s)=>new Promise((r,j)=>quickshopDb.query(s,(e,x)=>e?j(e):r(x)));
console.log(await q("SHOW COLUMNS FROM qs_data"));
console.log(await q("SHOW COLUMNS FROM qs_external_cache"));
console.log(await q("SELECT d.type, SUM(c.stock<0) neg_stock, SUM(c.stock=0) zero_stock, SUM(c.stock>0) pos_stock, SUM(c.space<0) neg_space, COUNT(*) n FROM qs_shops s JOIN qs_data d ON s.data=d.id JOIN qs_external_cache c ON c.shop=s.id WHERE d.unlimited=0 GROUP BY d.type"));
process.exit(0);
