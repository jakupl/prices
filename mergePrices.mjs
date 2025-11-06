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

async function safeFetchJson(url, attempts = 3, timeoutMs = 15000) {
  for (let i = 0; i < attempts; i++) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(id);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return json;
    } catch (err) {
      const last = i === attempts - 1;
      console.warn(`Fetch ${url} failed (attempt ${i+1}/${attempts}): ${err.message}${last ? " -> final" : ""}`);
      if (last) throw err;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
}

function parsePrice(val) {
  if (val === null || val === undefined) return NaN;
  if (typeof val === "number") return val;
  let s = String(val).trim();
  if (s === "") return NaN;
  s = s.replace(/[^\d\.,-]/g, "");
  if (s.indexOf(",") !== -1 && s.indexOf(".") !== -1) s = s.replace(/,/g, "");
  else s = s.replace(/,/g, ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

async function fetchSiteItems(url) {
  const json = await safeFetchJson(url);
  if (!json || typeof json.items !== "object") throw new Error("Nieoczekiwany format odpowiedzi");
  return json.items;
}

async function mergeAndSave() {
  console.log("Start mergeAndSave");
  const results = await Promise.all(sources.map(async s => {
    try {
      const json = await fetchSiteItems(s.url);
      const count = Object.keys(json || {}).length;
      console.log(`Fetched ${count} items from ${s.site}`);
      return { key: s.key, site: s.site, items: json };
    } catch (err) {
      console.error(`Błąd pobierania ${s.site}: ${err.message}`);
      return { key: s.key, site: s.site, items: {} };
    }
  }));

  const allNames = new Set();
  results.forEach(r => Object.keys(r.items || {}).forEach(n => allNames.add(n)));
  console.log(`Total distinct item names across sources: ${allNames.size}`);

  const transformed = { items: {} };
  for (const name of allNames) {
    const entry = { youpin898Price: null, buffPrice: null, csfloatPrice: null };
    for (const r of results) {
      const values = r.items[name];
      if (!values) continue;
      const rawPrice = values.p ?? values.price ?? null;
      const rawStock = values.c ?? values.count ?? values.stock ?? null;

      const price = parsePrice(rawPrice);
      const stock = Number(rawStock);
      if (!Number.isFinite(stock) || stock < STOCK_THRESHOLD || !Number.isFinite(price)) continue;

      let finalPrice = price;
      if (r.key === "buffPrice" || r.key === "youpin898Price") finalPrice = +(price / CNY_TO_USD).toFixed(2);

      entry[r.key] = finalPrice;
    }
    if (entry.youpin898Price !== null || entry.buffPrice !== null || entry.csfloatPrice !== null) {
      transformed.items[name] = entry;
    }
  }

  const countFinal = Object.keys(transformed.items).length;
  console.log(`Final merged items count: ${countFinal}`);

  fs.mkdirSync("public", { recursive: true });

  const outPath = "public/mergedPriceList.json";
  fs.writeFileSync(outPath + ".tmp", JSON.stringify(transformed, null, 2), "utf-8");
  fs.renameSync(outPath + ".tmp", outPath);
  console.log(`Zapisano ${outPath}`);

  if (countFinal === 0) {
    console.error("Final file has 0 items — exiting with error so CI can catch it");
    process.exit(4);
  }
}

mergeAndSave().catch(err => {
  console.error("mergeAndSave error:", err);
  process.exit(1);
});
