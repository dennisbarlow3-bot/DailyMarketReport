#!/usr/bin/env node
/*
 * Generates the Daily Market Report CSV: a rules-based screen of Nasdaq 100
 * stocks that suffered the largest one-day price drop AND pass a growth-tilted
 * fundamentals filter, intended to surface oversold growth names that may be
 * positioned for a near-term rebound.
 *
 * NOT financial advice. This is a transparent, deterministic, rules-based
 * screen on top of free, public Yahoo Finance data.
 *
 * Output path: out/daily-market-report-YYYY-MM-DD.csv (date in America/New_York).
 * The full path is printed to stdout on the last line so callers can capture it.
 *
 * Default universe: Nasdaq 100 (embedded list below — update DEFAULT_NDX_100
 * when the index is rebalanced). Override with the TICKERS env var
 * (comma-separated symbols) for testing or a custom universe.
 *
 * Data sources (no API key, no third-party npm deps — built-in https only):
 *   - https://query1.finance.yahoo.com/v8/finance/chart/{symbol} for quotes.
 *   - https://query1.finance.yahoo.com/v10/finance/quoteSummary/{symbol}
 *     for fundamentals (requires a one-time crumb+cookie handshake against
 *     fc.yahoo.com → /v1/test/getcrumb).
 *
 * Implementation note: uses `node:https` (HTTP/1.1) rather than global fetch
 * (HTTP/2 via undici). Yahoo's edge rate-limits H2 from datacenter IPs much
 * more aggressively than H1.1 with a browser User-Agent.
 *
 * Environment variables (all optional):
 *   TICKERS          Comma-separated symbol list overriding the Nasdaq 100.
 *   OUTPUT_COUNT     Max rows in the CSV body (default 20).
 *   MIN_MARKET_CAP   Minimum market cap in USD to pass the baseline filter
 *                    (default 2_000_000_000 = $2B).
 *   MIN_VOLUME       Minimum regular-market volume to pass the baseline filter
 *                    (default 100_000).
 *   MAX_CHANGE_PCT   Only rank names whose one-day change is below this
 *                    threshold (default 0 — i.e. require an actual drop).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

// Nasdaq 100 constituents. Update when Nasdaq rebalances (annually in December
// plus interim changes). Source of truth:
//   https://www.nasdaq.com/market-activity/quotes/nasdaq-ndx-index
// Override at runtime via the TICKERS env var if needed.
const DEFAULT_NDX_100 = [
  'AAPL', 'ABNB', 'ADBE', 'ADI',  'ADP',  'ADSK', 'AEP',  'AMAT', 'AMD',  'AMGN',
  'AMZN', 'ANSS', 'APP',  'ARM',  'ASML', 'AVGO', 'AXON', 'AZN',  'BIIB', 'BKNG',
  'BKR',  'CCEP', 'CDNS', 'CDW',  'CEG',  'CHTR', 'CMCSA','COST', 'CPRT', 'CRWD',
  'CSCO', 'CSGP', 'CSX',  'CTAS', 'CTSH', 'DASH', 'DDOG', 'DXCM', 'EA',   'EXC',
  'FANG', 'FAST', 'FTNT', 'GEHC', 'GFS',  'GILD', 'GOOG', 'GOOGL','HON',  'IDXX',
  'INTC', 'INTU', 'ISRG', 'KDP',  'KHC',  'KLAC', 'LIN',  'LRCX', 'LULU', 'MAR',
  'MCHP', 'MDB',  'MDLZ', 'MELI', 'META', 'MNST', 'MRVL', 'MSFT', 'MSTR', 'MU',
  'NFLX', 'NVDA', 'NXPI', 'ODFL', 'ON',   'ORLY', 'PANW', 'PAYX', 'PCAR', 'PDD',
  'PEP',  'PLTR', 'PYPL', 'QCOM', 'REGN', 'ROP',  'ROST', 'SBUX', 'SHOP', 'SNPS',
  'TEAM', 'TMUS', 'TSLA', 'TTD',  'TTWO', 'TXN',  'VRSK', 'VRTX', 'WBD',  'WDAY',
  'XEL',  'ZS',
];

const CSV_HEADER = [
  'rank',
  'symbol',
  'name',
  'price',
  'one_day_change_pct',
  'one_day_change',
  'volume',
  'market_cap',
  'revenue_growth',
  'profit_margins',
  'trailing_eps',
  'forward_eps',
  'debt_to_equity',
  'target_mean_price',
  'analyst_upside_pct',
  'recommendation_mean',
  'quality_score',
  'growth_score',
  'rebound_score',
  'total_score',
  'generated_at',
  'notes',
];

const YAHOO_HOSTS = [
  'https://query1.finance.yahoo.com',
  'https://query2.finance.yahoo.com',
];

const USER_AGENT = 'Mozilla/5.0';

function clampInt(raw, dflt, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

const OUTPUT_COUNT = clampInt(process.env.OUTPUT_COUNT, 20, 1, 100);
const MIN_MARKET_CAP = clampInt(process.env.MIN_MARKET_CAP, 2_000_000_000, 0, Number.MAX_SAFE_INTEGER);
const MIN_VOLUME = clampInt(process.env.MIN_VOLUME, 100_000, 0, Number.MAX_SAFE_INTEGER);
const MAX_CHANGE_PCT = Number.isFinite(parseFloat(process.env.MAX_CHANGE_PCT))
  ? parseFloat(process.env.MAX_CHANGE_PCT)
  : 0;

function nyDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildCsv(rows) {
  return rows.map((row) => row.map(csvEscape).join(',')).join('\n') + '\n';
}

function parseTickers() {
  const raw = (process.env.TICKERS || '').trim();
  if (!raw) return DEFAULT_NDX_100.slice();
  const parsed = raw.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
  return parsed.length ? parsed : DEFAULT_NDX_100.slice();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'object' && x !== null && 'raw' in x) {
    const r = x.raw;
    return typeof r === 'number' && Number.isFinite(r) ? r : null;
  }
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function httpGet(targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.setTimeout(20000, () => {
      req.destroy(new Error(`Request to ${u.hostname} timed out`));
    });
    req.on('error', reject);
    req.end();
  });
}

async function httpGetJson(targetUrl, headers = {}) {
  const res = await httpGet(targetUrl, headers);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} from ${new URL(targetUrl).hostname}`);
  }
  try {
    return JSON.parse(res.body);
  } catch (e) {
    throw new Error(`Invalid JSON from ${new URL(targetUrl).hostname}: ${e.message}`);
  }
}

// --- Yahoo crumb handshake -------------------------------------------------

async function getCrumbWithCookies(cookieHeader) {
  const res = await httpGet('https://query1.finance.yahoo.com/v1/test/getcrumb', { Cookie: cookieHeader });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Crumb request failed: HTTP ${res.status}`);
  }
  const crumb = res.body.trim();
  if (!crumb) throw new Error('Empty crumb returned from Yahoo');
  return { crumb, cookie: cookieHeader };
}

async function getYahooCrumb() {
  // Seed cookies (A1/A3) from fc.yahoo.com, then trade them at /v1/test/getcrumb.
  const seed = await httpGet('https://fc.yahoo.com/');
  const setCookies = []
    .concat(seed.headers['set-cookie'] || [])
    .map((c) => c.split(';')[0])
    .filter(Boolean);
  let cookieHeader = setCookies.join('; ');
  if (!cookieHeader) {
    const seed2 = await httpGet('https://finance.yahoo.com/');
    const sc2 = []
      .concat(seed2.headers['set-cookie'] || [])
      .map((c) => c.split(';')[0])
      .filter(Boolean);
    if (!sc2.length) throw new Error('Could not seed Yahoo cookies for crumb handshake');
    cookieHeader = sc2.join('; ');
  }
  return getCrumbWithCookies(cookieHeader);
}

// --- Quote (chart) and fundamentals (quoteSummary) -------------------------

async function fetchChart(symbol) {
  const qs = 'interval=1d&range=2d';
  let lastErr;
  for (const host of YAHOO_HOSTS) {
    const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`;
    try {
      const json = await httpGetJson(url);
      if (json && json.chart && json.chart.error) {
        throw new Error(`Yahoo chart error for ${symbol}: ${json.chart.error.description || json.chart.error.code}`);
      }
      const result = json && json.chart && Array.isArray(json.chart.result) ? json.chart.result[0] : null;
      if (!result || !result.meta) {
        throw new Error(`Unexpected Yahoo chart response for ${symbol}`);
      }
      return result;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`Failed to fetch chart for ${symbol}`);
}

async function fetchQuoteSummary(symbol, auth) {
  const modules = ['summaryDetail', 'financialData', 'defaultKeyStatistics', 'price'].join(',');
  let lastErr;
  for (const host of YAHOO_HOSTS) {
    const url = `${host}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&crumb=${encodeURIComponent(auth.crumb)}`;
    try {
      const json = await httpGetJson(url, { Cookie: auth.cookie });
      if (json && json.quoteSummary && json.quoteSummary.error) {
        throw new Error(`Yahoo quoteSummary error for ${symbol}: ${json.quoteSummary.error.description || json.quoteSummary.error.code}`);
      }
      const result = json && json.quoteSummary && Array.isArray(json.quoteSummary.result) ? json.quoteSummary.result[0] : null;
      if (!result) throw new Error(`Empty quoteSummary for ${symbol}`);
      return result;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`Failed to fetch quoteSummary for ${symbol}`);
}

function chartToQuote(symbol, chart) {
  const meta = chart.meta || {};
  const price = num(meta.regularMarketPrice);
  const prevClose = num(meta.chartPreviousClose);
  let change = null;
  let changePct = null;
  if (price !== null && prevClose !== null && prevClose !== 0) {
    change = price - prevClose;
    changePct = (change / prevClose) * 100;
  }
  return {
    symbol: meta.symbol || symbol,
    name: meta.shortName || meta.longName || '',
    price,
    prevClose,
    change,
    changePct,
    volume: num(meta.regularMarketVolume),
  };
}

function extractFundamentals(summary) {
  const sd = summary.summaryDetail || {};
  const fd = summary.financialData || {};
  const ks = summary.defaultKeyStatistics || {};
  const pr = summary.price || {};

  const price = num(pr.regularMarketPrice) ?? num(fd.currentPrice);
  const targetMean = num(fd.targetMeanPrice);
  let analystUpsidePct = null;
  if (price !== null && targetMean !== null && price > 0) {
    analystUpsidePct = ((targetMean - price) / price) * 100;
  }

  return {
    name: pr.longName || pr.shortName || '',
    marketCap: num(pr.marketCap) ?? num(sd.marketCap),
    revenueGrowth: num(fd.revenueGrowth),
    earningsGrowth: num(fd.earningsGrowth),
    profitMargins: num(fd.profitMargins) ?? num(ks.profitMargins),
    grossMargins: num(fd.grossMargins),
    operatingMargins: num(fd.operatingMargins),
    returnOnEquity: num(fd.returnOnEquity),
    trailingEps: num(ks.trailingEps),
    forwardEps: num(ks.forwardEps),
    debtToEquity: num(fd.debtToEquity),
    currentRatio: num(fd.currentRatio),
    targetMeanPrice: targetMean,
    analystUpsidePct,
    recommendationMean: num(fd.recommendationMean),
    numberOfAnalystOpinions: num(fd.numberOfAnalystOpinions),
  };
}

// --- Scoring ---------------------------------------------------------------

// Linear ramp from `lo` (→ 0) to `hi` (→ 1), clamped to [0,1]. Missing values
// return 0 so they don't artificially inflate component scores.
function bandScore(value, lo, hi) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  if (hi === lo) return value >= hi ? 1 : 0;
  return Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
}

function computeScores(q, f) {
  // Growth tilt: revenue and earnings growth dominate, with profit margin as
  // a tie-breaker. 30% growth saturates the band.
  const revG = bandScore(f.revenueGrowth, 0, 0.30);
  const earnG = bandScore(f.earningsGrowth, 0, 0.30);
  const margin = bandScore(f.profitMargins, 0, 0.25);
  const growthScore = 0.45 * revG + 0.30 * earnG + 0.25 * margin;

  // Quality: leverage (inverted), scale, liquidity, return on equity.
  const de = f.debtToEquity;
  const deScore = de === null ? 0.4 : Math.max(0, Math.min(1, 1 - de / 200));
  // marketCap log scale: $1B → 0, $1T → 1.
  const cap = f.marketCap === null ? 0 :
    Math.max(0, Math.min(1, (Math.log10(Math.max(f.marketCap, 1)) - 9) / 3));
  const cur = f.currentRatio === null ? 0.4 : bandScore(f.currentRatio, 1.0, 2.5);
  const roe = bandScore(f.returnOnEquity, 0, 0.25);
  const qualityScore = 0.35 * deScore + 0.25 * cap + 0.20 * cur + 0.20 * roe;

  // Rebound: size of the drop dominates; analyst upside + buy recommendation
  // add conviction that the move is reversible.
  const drop = q.changePct === null ? 0 : Math.max(0, Math.min(1, -q.changePct / 10));
  const upside = bandScore(f.analystUpsidePct, 0, 30);
  // recommendationMean: 1 = Strong Buy, 5 = Strong Sell. Convert to [0,1] where higher = bullish.
  const rec = f.recommendationMean === null ? 0.4 :
    Math.max(0, Math.min(1, (3.5 - f.recommendationMean) / 2.0));
  const reboundScore = 0.55 * drop + 0.25 * upside + 0.20 * rec;

  const totalScore = 0.50 * reboundScore + 0.30 * growthScore + 0.20 * qualityScore;

  return {
    growthScore: round4(growthScore),
    qualityScore: round4(qualityScore),
    reboundScore: round4(reboundScore),
    totalScore: round4(totalScore),
  };
}

function round4(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10000) / 10000;
}

function round2(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function round6(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  return Math.round(n * 1000000) / 1000000;
}

// --- Filtering -------------------------------------------------------------

function baselineNotes(q, f) {
  const notes = [];
  if (q.price === null) notes.push('missing price');
  if (q.volume === null || q.volume < MIN_VOLUME) notes.push(`volume below ${MIN_VOLUME}`);
  if (f.marketCap === null || f.marketCap <= 0) notes.push('non-positive market cap');
  else if (f.marketCap < MIN_MARKET_CAP) notes.push(`market cap below $${(MIN_MARKET_CAP / 1e9).toFixed(1)}B`);
  if (q.changePct === null) notes.push('missing change pct');
  else if (q.changePct >= MAX_CHANGE_PCT) notes.push('not a one-day decliner');
  return notes;
}

function reasoningNotes(q, f) {
  const notes = [];
  if (q.changePct !== null) notes.push(`one-day drop ${q.changePct.toFixed(2)}%`);
  if (f.revenueGrowth !== null) {
    const label = f.revenueGrowth > 0 ? '' : ' (negative)';
    notes.push(`revenue growth ${(f.revenueGrowth * 100).toFixed(1)}%${label}`);
  } else {
    notes.push('revenue growth n/a');
  }
  if (f.profitMargins !== null) {
    const label = f.profitMargins > 0 ? '' : ' (negative)';
    notes.push(`profit margin ${(f.profitMargins * 100).toFixed(1)}%${label}`);
  }
  if (f.analystUpsidePct !== null && f.analystUpsidePct > 0) {
    notes.push(`analyst upside ${f.analystUpsidePct.toFixed(1)}%`);
  }
  if (f.recommendationMean !== null) {
    notes.push(`rec mean ${f.recommendationMean.toFixed(2)}`);
  }
  if (f.debtToEquity === null) notes.push('debt/equity n/a');
  return notes;
}

// --- Pipeline --------------------------------------------------------------

async function loadOne(symbol, auth) {
  const [chart, summary] = await Promise.all([
    fetchChart(symbol),
    fetchQuoteSummary(symbol, auth),
  ]);
  const q = chartToQuote(symbol, chart);
  const f = extractFundamentals(summary);
  if (!q.name && f.name) q.name = f.name;
  return { q, f };
}

async function loadAll(tickers, auth) {
  const results = [];
  const failures = [];
  // Sequential with small spacing — Yahoo rate-limits aggressively from CI IPs.
  for (const sym of tickers) {
    try {
      const r = await loadOne(sym, auth);
      results.push({ symbol: sym, ...r });
    } catch (err) {
      console.error(`  ! ${sym}: ${err.message || err}`);
      failures.push(sym);
    }
    await sleep(150);
  }
  return { results, failures };
}

function rowFor(rank, entry, generatedAt) {
  const { q, f, scores, notes } = entry;
  return [
    rank,
    q.symbol,
    q.name,
    round2(q.price),
    round2(q.changePct),
    round2(q.change),
    q.volume,
    f.marketCap,
    round6(f.revenueGrowth),
    round6(f.profitMargins),
    round2(f.trailingEps),
    round2(f.forwardEps),
    round2(f.debtToEquity),
    round2(f.targetMeanPrice),
    round2(f.analystUpsidePct),
    round2(f.recommendationMean),
    scores.qualityScore,
    scores.growthScore,
    scores.reboundScore,
    scores.totalScore,
    generatedAt,
    notes.join('; '),
  ];
}

async function main() {
  const tickers = parseTickers();
  const date = nyDate();
  const outDir = path.resolve(__dirname, '..', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `daily-market-report-${date}.csv`);

  console.error(`Universe: ${tickers.length} tickers (default = Nasdaq 100).`);
  console.error(`Filters: MIN_MARKET_CAP=$${MIN_MARKET_CAP}, MIN_VOLUME=${MIN_VOLUME}, MAX_CHANGE_PCT=${MAX_CHANGE_PCT}%`);
  console.error(`OUTPUT_COUNT=${OUTPUT_COUNT}`);

  console.error('Performing Yahoo crumb handshake...');
  const auth = await getYahooCrumb();

  console.error('Fetching quotes + fundamentals...');
  const { results, failures } = await loadAll(tickers, auth);

  if (results.length === 0) {
    throw new Error('No data returned from Yahoo Finance — refusing to write empty CSV.');
  }
  if (failures.length) {
    console.error(`Warning: ${failures.length} symbol(s) failed: ${failures.join(', ')}`);
  }

  const qualified = [];
  for (const r of results) {
    const baseline = baselineNotes(r.q, r.f);
    if (baseline.length > 0) continue;
    const scores = computeScores(r.q, r.f);
    const notes = reasoningNotes(r.q, r.f);
    qualified.push({ ...r, scores, notes });
  }

  if (qualified.length === 0) {
    throw new Error(
      `No qualifying rows (universe=${results.length}, all filtered out by baseline). ` +
      'Check market data availability or relax MIN_MARKET_CAP/MIN_VOLUME/MAX_CHANGE_PCT.'
    );
  }

  // Sort: largest one-day decline first (most negative changePct); tie-break
  // by higher total score so growthier rebounds rank above weaker ones.
  qualified.sort((a, b) => {
    const ap = a.q.changePct ?? 0;
    const bp = b.q.changePct ?? 0;
    if (ap !== bp) return ap - bp;
    return b.scores.totalScore - a.scores.totalScore;
  });

  const picked = qualified.slice(0, OUTPUT_COUNT);
  if (picked.length < OUTPUT_COUNT) {
    console.error(
      `Only ${picked.length} of ${OUTPUT_COUNT} requested rows qualified ` +
      `(universe=${results.length}, qualified=${qualified.length}). ` +
      'Writing the available qualified rows.'
    );
  }

  const generatedAt = new Date().toISOString();
  const rows = [
    CSV_HEADER,
    ...picked.map((entry, i) => rowFor(i + 1, entry, generatedAt)),
  ];
  fs.writeFileSync(outFile, buildCsv(rows), 'utf8');

  console.error(`Wrote ${picked.length} ranked rows: ${outFile}`);
  console.log(outFile);
}

main().catch((err) => {
  console.error(`generate-report failed: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
