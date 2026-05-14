#!/usr/bin/env node
/*
 * Generates the Daily Market Report CSV.
 *
 * Output path: out/daily-market-report-YYYY-MM-DD.csv (date in America/New_York).
 * The full path is printed to stdout on the last line so callers can capture it.
 *
 * Replace the sample rows below with the project's real data-fetching logic
 * once available. The workflow only requires that a CSV exists at the printed
 * path before the email step runs.
 */

const fs = require('fs');
const path = require('path');

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
  const s = String(value ?? '');
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildCsv(rows) {
  return rows.map((row) => row.map(csvEscape).join(',')).join('\n') + '\n';
}

function main() {
  const date = nyDate();
  const outDir = path.resolve(__dirname, '..', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `daily-market-report-${date}.csv`);

  const rows = [
    ['Symbol', 'Name', 'Close', 'Change', 'Change %'],
    ['SPX', 'S&P 500 Index', '', '', ''],
    ['DJI', 'Dow Jones Industrial Average', '', '', ''],
    ['IXIC', 'NASDAQ Composite', '', '', ''],
  ];

  fs.writeFileSync(outFile, buildCsv(rows), 'utf8');

  console.error(`Wrote report: ${outFile}`);
  console.log(outFile);
}

main();
