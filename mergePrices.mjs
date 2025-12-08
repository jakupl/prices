import fs from "fs";

const API_KEY = "8R4voOJHFLcxte3GhBMNKjSmkpQRO7k8bsR6TypaOS5O-cKdzK";
if (!API_KEY) {
  console.error("Brakuje SKINS_API_KEY w env");
  process.exit(2);
}

const app = "730";
const CNY_TO_USD = 1;
const STOCK_THRESHOLD = 1;

const YOUPIN_ALLOWED_HOURS = [4, 12, 20];
const YOUPIN_CACHE_PATH = "public/lastYoupin.json";
const YOUPIN_STALE_MS = 24 * 60 * 60 * 1000; // 24h

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

/**
 * Cache helpers
 * Cache file structure:
 * {
 *   fetchedAt: "2025-12-08T14:21:00.000Z",
 *   items: { "<market_hash_name>": { p: <price>, c: <stock> }, ... }
 * }
 */
function loadYoupinCacheRaw() {
  try {
    if (!fs.existsSync(YOUPIN_CACHE_PATH)) return null;
    const raw = fs.readFileSync(YOUPIN_CACHE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.warn("Nieudane wczytanie cache YOUPIN:", err.message);
    return null;
  }
}

function loadYoupinCacheItems() {
  const raw = loadYoupinCacheRaw();
  return raw && raw.items && typeof raw.items === "object" ? raw.items : null;
}

function saveYoupinCache(items) {
  try {
    const payload = {
      fetchedAt: new Date().toISOString(),
      items: items || {}
    };
    fs.mkdirSync("public", { recursive: true });
    fs.writeFileSync(YOUPIN_CACHE_PATH, JSON.stringify(payload, null, 2), "utf-8");
    console.log("Zapisano lastYoupin.json (cache)");
  } catch (err) {
    console.error("Błąd zapisu lastYoupin.json:", err.message);
  }
}

function isYoupinCacheStale() {
  const raw = loadYoupinCacheRaw();
  if (!raw || !raw.fetchedAt) return true;
  const t = Date.parse(raw.fetchedAt);
  if (Number.isNaN(t)) return true;
  return (Date.now() - t) > YOUPIN_STALE_MS;
}

async function mergeAndSave() {
  console.log("Start mergeAndSave");

  const allowedNow = isYoupinAllowedNow();
  const cacheExists = !!loadYoupinCacheItems();
  const cacheStale = isYoupinCacheStale();

  // Decide whether we should fetch youpin this run:
  // - if allowedNow -> fetch
  // - else if cache stale or missing -> force fetch (to ensure at least once per 24h)
  // - else -> do not fetch
  const shouldFetchYoupin = allowedNow || cacheStale;

  if (allowedNow) {
    console.log("YOUPIN: dozwolona godzina — będzie pobierany.");
  } else if (cacheStale) {
    console.log("YOUPIN: cache brak/nieaktualny (>24h) — wymuszone pobranie mimo godzin niedozwolonych.");
  } else {
    console.log("YOUPIN: godzina niedozwolona i cache świeży — używam cache.");
  }

  // Fetch other sources (buff, csfloat) in parallel
  const otherSources = sources.filter(s => s.key !== "youpin");
  const otherResults = await Promise.all(
    otherSources.map(async (s) => {
      try {
        const items = await fetchSiteItems(s);
        console.log(`Fetched ${Object.keys(items).length} items from ${s.site}`);
        return { key: s.key, site: s.site, items };
      } catch (err) {
        console.error(`Błąd pobierania ${s.site}: ${err.message}`);
        return { key: s.key, site: s.site, items: {} };
      }
    })
  );

  // Handle YOUPIN separately according to decision
  let youpinResult = null;
  const youpinSource = sources.find(s => s.key === "youpin");

  if (shouldFetchYoupin) {
    try {
      const items = await fetchSiteItems(youpinSource);
      console.log(`Fetched ${Object.keys(items).length} items from YOUPIN (live)`);
      youpinResult = { key: "youpin", site: "YOUPIN898", items };
      // save cache
      saveYoupinCache(items);
    } catch (err) {
      console.error(`Błąd pobierania YOUPIN: ${err.message}`);
      const cachedItems = loadYoupinCacheItems();
      if (cachedItems) {
        console.log("Błąd pobierania YOUPIN — używam cache jako fallback");
        youpinResult = { key: "youpin", site: "YOUPIN898 (cache-fallback)", items: cachedItems };
      } else {
        console.log("Błąd pobierania YOUPIN i brak cache — YOUPIN będzie pominięty");
        youpinResult = { key: "youpin", site: "YOUPIN898", items: {} };
      }
    }
  } else {
    // not supposed to fetch; use cache if exists
    const cachedItems = loadYoupinCacheItems();
    if (cachedItems) {
      console.log("Używam YOUPIN z cache (bez pobierania)");
      youpinResult = { key: "youpin", site: "YOUPIN898 (cache)", items: cachedItems };
    } else {
      console.log("Brak cache YOUPIN i pobieranie nie jest dozwolone — pomijam YOUPIN");
      youpinResult = { key: "youpin", site: "YOUPIN898", items: {} };
    }
  }

  // Combine all results
  const results = [...otherResults, youpinResult];

  // ---------------------------------------------
  // MERGING
  // ---------------------------------------------

  const allNames = new Set();
  results.forEach(r => Object.keys(r.items || {}).forEach(n => allNames.add(n)));
  console.log(`Total distinct item names: ${allNames.size}`);

  const transformed = { items: {} };

  for (const name of allNames) {
    const candidates = [];

    for (const r of results) {
      const v = r.items[name];
      if (!v) continue;

      const price = parsePrice(v.p ?? v.price);
      const stock = Number(v.c ?? v.count ?? v.stock);

      if (!Number.isFinite(price) || !Number.isFinite(stock) || stock < STOCK_THRESHOLD)
        continue;

      let finalPrice = price;
      if (r.key === "buff" || r.key === "youpin") finalPrice = price / CNY_TO_USD;

      candidates.push({ price: finalPrice, site: r.key });
    }

    if (candidates.length === 0) continue;

    candidates.sort((a, b) => {
      if (a.price !== b.price) return a.price - b.price;
      const pref = { csfloat: 0, buff: 1, youpin: 2 };
      return (pref[a.site] ?? 99) - (pref[b.site] ?? 99);
    });

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
