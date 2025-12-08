import fs from "fs";

const API_KEY = "8R4voOJHFLcxte3GhBMNKjSmkpQRO7k8bsR6TypaOS5O-cKdzK";
if (!API_KEY) {
  console.error("Brakuje SKINS_API_KEY w env");
  process.exit(2);
}

const app = "730";
const CNY_TO_USD = 7.13;
const STOCK_THRESHOLD = 1;

const YOUPIN_ALLOWED_HOURS = [4, 12, 20];
const YOUPIN_CACHE_PATH = "public/lastYoupin.json";

const sources = [
  {
    site: "BUFF.163",
    key: "buff",
    url: `https://jakupl.github.io/buff/buffPriceList.json`,
    custom: "buff"
  },
  {
    site: "CSFLOAT",
    key: "csfloat",
    url: `https://jakupl.github.io/csfloat/floatPriceList.json`,
    custom: "csfloat"
  },
  {
    site: "YOUPIN898",
    key: "youpin",
    url: `https://skins-table.com/api_v2/items?apikey=${API_KEY}&app=${app}&site=YOUPIN898`
  }
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
      console.warn(`Fetch ${url} failed (attempt ${i + 1}/${attempts}): ${err.message}${last ? " -> final" : ""}`);
      if (last) throw err;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
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

async function fetchSiteItems(source) {
  const json = await safeFetchJson(source.url);

  if (source.custom === "csfloat") {
    if (!json || typeof json.items !== "object") {
      throw new Error(`Nieoczekiwany format CSFLOAT`);
    }
    const converted = {};
    for (const [name, obj] of Object.entries(json.items)) {
      converted[name] = { p: obj.price, c: obj.stock };
    }
    return converted;
  }

  if (source.custom === "buff") {
    const converted = {};

    if (Array.isArray(json)) {
      for (const entry of json) {
        const name = entry.market_hash_name ?? entry.market_name ?? entry.name;
        if (!name) continue;
        converted[name] = { p: entry.price, c: entry.stock };
      }
      return converted;
    }

    if (json?.items && typeof json.items === "object") {
      for (const [name, obj] of Object.entries(json.items)) {
        converted[name] = { p: obj.price, c: obj.stock };
      }
      return converted;
    }

    throw new Error("Nieoczekiwany format BUFF");
  }

  if (!json || typeof json.items !== "object") {
    throw new Error("Nieoczekiwany format YOUPIN/skins-table");
  }

  return json.items;
}

function getWarsawHour() {
  const hourStr = new Date().toLocaleString("en-GB", {
    timeZone: "Europe/Warsaw",
    hour12: false,
    hour: "2-digit"
  });
  const h = Number(hourStr);
  return Number.isFinite(h) ? h : new Date().getHours();
}

function isYoupinAllowedNow() {
  return YOUPIN_ALLOWED_HOURS.includes(getWarsawHour());
}

function loadYoupinCache() {
  try {
    if (!fs.existsSync(YOUPIN_CACHE_PATH)) return null;
    const raw = fs.readFileSync(YOUPIN_CACHE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveYoupinCache(data) {
  try {
    fs.mkdirSync("public", { recursive: true });
    fs.writeFileSync(YOUPIN_CACHE_PATH, JSON.stringify(data, null, 2), "utf-8");
    console.log("Zapisano lastYoupin.json");
  } catch (err) {
    console.error("Błąd zapisu lastYoupin.json:", err.message);
  }
}

async function mergeAndSave() {
  console.log("Start mergeAndSave");

  const youpinAllowed = isYoupinAllowedNow();

  if (youpinAllowed) {
    console.log(`YOUPIN: godzina dozwolona → będzie pobierany.`);
  } else {
    console.log(`YOUPIN: godzina niedozwolona → używam cache.`);
  }

  const actualSources = sources.filter(
    s => !(s.key === "youpin" && !youpinAllowed)
  );

  const results = await Promise.all(
    actualSources.map(async (s) => {
      try {
        const json = await fetchSiteItems(s);
        console.log(`Fetched ${Object.keys(json).length} items from ${s.site}`);
        return { key: s.key, site: s.site, items: json };
      } catch (err) {
        console.error(`Błąd pobierania ${s.site}: ${err.message}`);
        return { key: s.key, site: s.site, items: {} };
      }
    })
  );

  // Jeśli YOUPIN był pobrany → zapisz cache
  if (youpinAllowed) {
    const youpinData = results.find(r => r.key === "youpin")?.items ?? {};
    saveYoupinCache(youpinData);
  }

  // Jeśli YOUPIN był pominięty → użyj cache jeżeli istnieje
  if (!youpinAllowed) {
    const cached = loadYoupinCache();
    if (cached) {
      console.log("Załadowano YOUPIN z cache");
      results.push({ key: "youpin", site: "YOUPIN898 (cache)", items: cached });
    } else {
      console.log("Brak YOUPIN w cache — pomijam");
      results.push({ key: "youpin", site: "YOUPIN898", items: {} });
    }
  }

  // ---------------------------------------------
  // MERGING
  // ---------------------------------------------

  const allNames = new Set();
  results.forEach(r => Object.keys(r.items).forEach(n => allNames.add(n)));
  console.log(`Total distinct item names: ${allNames.size}`);

  const transformed = { items: {} };

  for (const name of allNames) {
    const candidates = [];

    for (const r of results) {
      const v = r.items[name];
      if (!v) continue;

      const price = parsePrice(v.p);
      const stock = Number(v.c);

      if (!Number.isFinite(price) || !Number.isFinite(stock) || stock < STOCK_THRESHOLD)
        continue;

      let finalPrice = price;
      if (r.key === "buff" || r.key === "youpin") finalPrice = price / CNY_TO_USD;

      candidates.push({ price: finalPrice, site: r.key });
    }

    if (candidates.length === 0) continue;

    candidates.sort((a, b) => a.price - b.price);

    const best = candidates[0];
    transformed.items[name] = {
      price: Math.round(best.price * 100) / 100,
      site: best.site
    };
  }

  fs.mkdirSync("public", { recursive: true });
  const outPath = "public/mergedPriceList.json";
  fs.writeFileSync(outPath + ".tmp", JSON.stringify(transformed, null, 2), "utf-8");
  fs.renameSync(outPath + ".tmp", outPath);

  console.log(`Zapisano ${outPath}`);
}

mergeAndSave().catch((err) => {
  console.error("mergeAndSave error:", err);
  process.exit(1);
});
