// mergePrices.mjs
import fs from "fs";

const API_KEY = process.env.SKINS_API_KEY;
if (!API_KEY) {
  console.error("Brakuje SKINS_API_KEY w env");
  process.exit(2);
}

const app = "730";
const CNY_TO_USD = 7.13;
const STOCK_THRESHOLD = 1;

const sources = [
  { site: "BUFF.163", key: "buffPrice", url: `https://skins-table.com/api_v2/items?apikey=${API_KEY}&app=${app}&site=BUFF.163` },
  { site: "CSFLOAT", key: "csfloatPrice", url: `https://skins-table.com/api_v2/items?apikey=${API_KEY}&app=${app}&site=CSFLOAT` },
  { site: "YOUPIN898", key: "youpin898Price", url: `https://skins-table.com/api_v2/items?apikey=${API_KEY}&app=${app}&site=YOUPIN898` }
];

async function fetchSiteItems(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} dla ${url}`);
  const json = await res.json();
  if (!json || typeof json.items !== "object") throw new Error("Nieoczekiwany format odpowiedzi");
  return json.items;
}

async function mergeAndSave() {
  const results = await Promise.all(sources.map(s =>
    fetchSiteItems(s.url).then(items => ({ key: s.key, site: s.site, items })).catch(err => {
      console.error(`Błąd pobierania ${s.site}: ${err.message}`);
      return { key: s.key, site: s.site, items: {} };
    })
  ));

  const allNames = new Set();
  results.forEach(r => Object.keys(r.items || {}).forEach(n => allNames.add(n)));

  const transformed = { items: {} };
  for (const name of allNames) {
    const entry = { youpin898Price: null, buffPrice: null, csfloatPrice: null };
    for (const r of results) {
      const values = r.items[name];
      if (!values) continue;
      const price = Number(values.p);
      const stock = Number(values.c);
      if (!Number.isFinite(stock) || stock < STOCK_THRESHOLD || !Number.isFinite(price)) continue;
      let finalPrice = price;
      if (r.key === "buffPrice" || r.key === "youpin898Price") finalPrice = +(price / CNY_TO_USD).toFixed(3);
      entry[r.key] = finalPrice;
    }
    if (entry.youpin898Price !== null || entry.buffPrice !== null || entry.csfloatPrice !== null) {
      transformed.items[name] = entry;
    }
  }

  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync("public/mergedPriceList.json", JSON.stringify(transformed, null, 2), "utf-8");
  console.log("Zapisano public/mergedPriceList.json");
}

mergeAndSave().catch(err => {
  console.error("mergeAndSave error:", err);
  process.exit(1);
});
