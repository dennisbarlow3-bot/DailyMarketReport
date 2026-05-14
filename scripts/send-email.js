#!/usr/bin/env node
/*
 * Sends the Daily Market Report CSV as an email attachment via Gmail SMTP.
 *
 * Required env vars:
 *   GMAIL_USERNAME      Gmail address used for SMTP auth (e.g. you@gmail.com)
 *   GMAIL_APP_PASSWORD  16-char Gmail App Password (no spaces)
 *   EMAIL_TO            Recipient address (comma-separated for multiple)
 *
 * Optional env vars:
 *   EMAIL_FROM_NAME     Display name for the From header (default: "Daily Market Report")
 *   SMTP_HOST           Default: smtp.gmail.com
 *   SMTP_PORT           Default: 587  (STARTTLS). Use 465 for implicit SSL.
 *   SMTP_SECURE         Default: false. Set "true" when using port 465.
 *   SMTP_REQUIRE_TLS    Default: true. Set "false" when SMTP_SECURE=true.
 *   REPORT_CSV_PATH     Path to the CSV to attach. If unset, the newest
 *                       out/daily-market-report-*.csv is used.
 *   REPORT_DATE         YYYY-MM-DD used in the subject line. Defaults to
 *                       today in America/New_York.
 */

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function boolEnv(name, defaultValue) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultValue;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function nyDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function findLatestReport() {
  const outDir = path.resolve(__dirname, '..', 'out');
  if (!fs.existsSync(outDir)) return null;
  const files = fs
    .readdirSync(outDir)
    .filter((f) => /^daily-market-report-\d{4}-\d{2}-\d{2}\.csv$/.test(f))
    .map((f) => ({ f, mtime: fs.statSync(path.join(outDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? path.join(outDir, files[0].f) : null;
}

async function main() {
  const username = requireEnv('GMAIL_USERNAME');
  const password = requireEnv('GMAIL_APP_PASSWORD');
  const to = requireEnv('EMAIL_TO');
  const fromName = process.env.EMAIL_FROM_NAME || 'Daily Market Report';

  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = boolEnv('SMTP_SECURE', false);
  const requireTLS = boolEnv('SMTP_REQUIRE_TLS', !secure);

  const csvPath = process.env.REPORT_CSV_PATH || findLatestReport();
  if (!csvPath) {
    throw new Error(
      'No CSV report found. Set REPORT_CSV_PATH or place a CSV in out/.'
    );
  }
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV report not found at: ${csvPath}`);
  }

  const reportDate = process.env.REPORT_DATE || nyDate();
  const subject = `Daily Market Report - ${reportDate}`;
  const attachmentName = `daily-market-report-${reportDate}.csv`;

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS,
    auth: { user: username, pass: password },
  });

  await transporter.verify();

  const info = await transporter.sendMail({
    from: { name: fromName, address: username },
    to,
    subject,
    text:
      `Attached is the Daily Market Report for ${reportDate}.\n\n` +
      `This message was sent automatically by the daily-market-report-email GitHub Actions workflow.\n`,
    attachments: [
      {
        filename: attachmentName,
        path: csvPath,
        contentType: 'text/csv',
      },
    ],
  });

  console.log(`Sent message id=${info.messageId} to=${to} attachment=${attachmentName}`);
}

main().catch((err) => {
  console.error(`send-email failed: ${err.message}`);
  process.exit(1);
});
