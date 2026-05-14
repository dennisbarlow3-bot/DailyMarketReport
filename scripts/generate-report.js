#!/usr/bin/env node
/*
 * Generates the Daily Market Report CSV with live quotes from Yahoo Finance.
 *
 * Output path: out/daily-market-report-YYYY-MM-DD.csv (date in America/New_York).
 * The full path is printed to stdout on the last line so callers can capture it.
 *
 * Tickers: default list below, or override with the TICKERS env var
 * (comma-separated, e.g. TICKERS="SPY,QQQ,AAPL").
 *
 * Data source: Yahoo Finance public chart endpoint (no API key required).
 *   https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=2d
 *
 * The v7 /finance/quote endpoint now requires a crumb+cookie handshake and
 * frequently returns HTTP 429 from CI IPs, so we use the per-symbol chart
 * endpoint, which exposes the same regularMarket* fields in `meta` and OHLC
 * in `indicators.quote`. marketCap is not provided by the chart endpoint;
 * that column is left blank.
 *
 * Implementation note: we use `node:https` (HTTP/1.1) rather than the global
 * fetch (HTTP/2 via undici) because Yahoo's edge rate-limits H2 connections
 * from datacenter ranges aggressively while H1.1 with a browser UA succeeds.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const DEFAULT_TICKERS = [
  'SPY', 'QQQ', 'DIA', 'AAPL', 'MSFT',
  'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA',
];

const CSV_HEADER = [
  'symbol',
  'name',
  'regularMarketPrice',
  'regularMarketChange',
  'regularMarketChangePercent',
  'regularMarketVolume',
  'regularMarketTime',
  'regularMarketOpen',
  'regularMarketDayHigh',
  'regularMarketDayLow',
  'regularMarketPreviousClose',
  'marketCap',
  'generated_at',
];

const YAHOO_HOSTS = [
  'https://query1.finance.yahoo.com',
  'https://query2.finance.yahoo.com',
];

// Short UA — Yahoo's edge throttles full Chrome UAs from datacenter IPs much
// more aggressively than a bare "Mozilla/5.0", while still rejecting the
// default Node user agent.
const USER_AGENT = 'Mozilla/5.0';

function nyDate() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildCsv(rows) {
  return rows.map((row) => row.map(csvEscape).join(',')).join('\n') + '\n';
}

function parseTickers() {
  const raw = (process.env.TICKERS || '').trim();
  if (!raw) return DEFAULT_TICKERS;
  const parsed = raw.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
  return parsed.length ? parsed : DEFAULT_TICKERS;
}

function formatMarketTime(epochSeconds) {
  if (epochSeconds === null || epochSeconds === undefined) return '';
  const n = Number(epochSeconds);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n * 1000).toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGetJson(targetUrl) {
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
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage || ''} from ${u.hostname}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`Invalid JSON from ${u.hostname}: ${e.message}`));
          }
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

async function fetchChart(symbol) {
  const qs = 'interval=1d&range=2d';
  let lastErr;
  for (const host of YAHOO_HOSTS) {
    const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`;
    try {
      const json = await httpGetJson(url);
      if (json && json.chart && json.chart.error) {
        throw new Error(`Yahoo error for ${symbol}: ${json.chart.error.description || json.chart.error.code}`);
      }
      const result = json && json.chart && Array.isArray(json.chart.result) ? json.chart.result[0] : null;
      if (!result || !result.meta) {
        throw new Error(`Unexpected Yahoo response for ${symbol}: missing chart.result[0].meta`);
      }
      return result;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`Failed to fetch ${symbol}`);
}

function num(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

function chartToQuote(symbol, chart) {
  const meta = chart.meta || {};
  const indicators = (chart.indicators && Array.isArray(chart.indicators.quote)) ? chart.indicators.quote[0] || {} : {};
  const opens = Array.isArray(indicators.open) ? indicators.open : [];
  const todaysOpen = opens.length ? num(opens[opens.length - 1]) : null;

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
    regularMarketPrice: price,
    regularMarketChange: change,
    regularMarketChangePercent: changePct,
    regularMarketVolume: num(meta.regularMarketVolume),
    regularMarketTime: formatMarketTime(meta.regularMarketTime),
    regularMarketOpen: todaysOpen,
    regularMarketDayHigh: num(meta.regularMarketDayHigh),
    regularMarketDayLow: num(meta.regularMarketDayLow),
    regularMarketPreviousClose: prevClose,
    marketCap: null,
  };
}

function quoteToRow(q, generatedAt) {
  return [
    q.symbol,
    q.name,
    q.regularMarketPrice,
    q.regularMarketChange,
    q.regularMarketChangePercent,
    q.regularMarketVolume,
    q.regularMarketTime,
    q.regularMarketOpen,
    q.regularMarketDayHigh,
    q.regularMarketDayLow,
    q.regularMarketPreviousClose,
    q.marketCap,
    generatedAt,
  ];
}

async function fetchAllQuotes(tickers) {
  const out = [];
  const failures = [];
  for (const sym of tickers) {
    try {
      const chart = await fetchChart(sym);
      out.push(chartToQuote(sym, chart));
    } catch (err) {
      console.error(`  ! ${sym}: ${err.message || err}`);
      failures.push(sym);
    }
    await sleep(150); // small spacing to be polite to Yahoo
  }
  return { quotes: out, failures };
}

async function main() {
  const tickers = parseTickers();
  const date = nyDate();
  const outDir = path.resolve(__dirname, '..', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `daily-market-report-${date}.csv`);

  console.error(`Fetching quotes for: ${tickers.join(', ')}`);
  const { quotes, failures } = await fetchAllQuotes(tickers);

  if (quotes.length === 0) {
    throw new Error('No quote rows returned from Yahoo Finance — refusing to write empty CSV.');
  }
  if (failures.length) {
    console.error(`Warning: ${failures.length} symbol(s) failed: ${failures.join(', ')}`);
  }

  const generatedAt = new Date().toISOString();
  const rows = [CSV_HEADER, ...quotes.map((q) => quoteToRow(q, generatedAt))];

  fs.writeFileSync(outFile, buildCsv(rows), 'utf8');

  console.error(`Wrote report with ${quotes.length} rows: ${outFile}`);
  console.log(outFile);
}

main().catch((err) => {
  console.error(`generate-report failed: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
