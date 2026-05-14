# Daily Market Report

Automated daily market report. A GitHub Actions workflow generates a CSV and
emails it via Gmail SMTP on business days at 6:00 PM America/New_York.

## Repository layout

- `client/` — React app (Create React App).
- `server/` — Express server (`server/server.js`) and a placeholder Python
  fetcher (`server/fetch.py`).
- `scripts/generate-report.js` — Fetches live stock quotes from Yahoo Finance
  and writes `out/daily-market-report-YYYY-MM-DD.csv` (date in
  America/New_York). Prints the absolute path of the generated file on its
  last stdout line so callers (including the workflow) can capture it.
- `scripts/send-email.js` — Sends the latest report as an email attachment
  using [nodemailer](https://nodemailer.com/) over Gmail SMTP.
- `.github/workflows/daily-market-report-email.yml` — Scheduled email workflow.

## npm scripts (root)

```bash
npm install              # install nodemailer
npm run generate:report  # writes out/daily-market-report-YYYY-MM-DD.csv
npm run send:email       # sends the latest CSV via Gmail SMTP
npm run daily-report     # generate + send in one step
```

> If your real report-generation lives elsewhere (for example under
> `server/`), swap the body of `scripts/generate-report.js` to invoke it —
> the workflow only requires the script to print the CSV path on its last
> stdout line.

## Data source and tickers

`scripts/generate-report.js` pulls quotes from the public Yahoo Finance
chart endpoint (`query1.finance.yahoo.com/v8/finance/chart/{symbol}`).
No API key is required, and no third-party npm dependencies are added —
the script uses Node's built-in `https` module.

**Default tickers:** `SPY, QQQ, DIA, AAPL, MSFT, NVDA, GOOGL, AMZN, META, TSLA`.

**Customize the universe** by setting the `TICKERS` environment variable to
a comma-separated list of Yahoo Finance symbols:

```bash
TICKERS="SPY,QQQ,AAPL,MSFT" npm run generate:report
```

In the workflow, add `TICKERS` under the *Generate report* step's `env:`
block to use a custom list on scheduled runs.

### CSV columns

`symbol`, `name`, `regularMarketPrice`, `regularMarketChange`,
`regularMarketChangePercent`, `regularMarketVolume`, `regularMarketTime`
(ISO 8601 UTC), `regularMarketOpen`, `regularMarketDayHigh`,
`regularMarketDayLow`, `regularMarketPreviousClose`, `marketCap` (left blank
— the chart endpoint does not expose it), `generated_at` (ISO 8601 UTC).

Fields are CSV-escaped (values containing commas, quotes, or newlines are
quoted), missing values render as empty cells, and the run fails if **no**
rows can be fetched so the workflow does not email an empty report.

## GitHub Actions workflow

File: `.github/workflows/daily-market-report-email.yml`

- Triggers: `workflow_dispatch` (manual) and two `schedule` crons.
- Schedules (cron is UTC; both seasonal times are listed so one matches
  6:00 PM New York year-round):
  - `0 22 * * 1-5` → 18:00 New York during **EDT** (daylight saving).
  - `0 23 * * 1-5` → 18:00 New York during **EST** (standard time).
- A guard step sets `TZ=America/New_York` and exits unless the local day is
  Mon–Fri **and** the local time is exactly `18:00`. This prevents both
  schedules from firing on the same day.
- `workflow_dispatch` runs skip the guard so maintainers can test on demand.

## Required GitHub Secrets

Set these under **Settings → Secrets and variables → Actions → New
repository secret**:

| Secret               | Example / expected value                                   |
| -------------------- | ---------------------------------------------------------- |
| `GMAIL_USERNAME`     | `dennis.barlow3@gmail.com`                                 |
| `GMAIL_APP_PASSWORD` | 16-character Gmail App Password, **no spaces**             |
| `EMAIL_TO`           | `dennis.barlow3@gmail.com` (comma-separate for multiple)   |
| `EMAIL_FROM_NAME`    | `Daily Market Report`                                      |

### Generating a Gmail App Password

1. Enable 2-Step Verification on the sending Google account.
2. Go to <https://myaccount.google.com/apppasswords>.
3. Create an App Password labelled e.g. *Daily Market Report*.
4. Copy the 16 characters Google displays and paste them into
   `GMAIL_APP_PASSWORD` **with no spaces**.

> Regular Gmail account passwords will not work — Google requires an App
> Password for SMTP when 2-Step Verification is on.

## Gmail SMTP settings

The workflow uses **STARTTLS on port 587** by default:

```text
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
```

To switch to **implicit TLS on port 465** instead, edit the `env:` block of
the *Send email* step in the workflow (or set the same vars locally):

```text
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_REQUIRE_TLS=false
```

Both options are supported by `smtp.gmail.com`; pick whichever your network
allows. 587/STARTTLS is the more broadly compatible default.

## Testing the workflow

1. Add the four secrets listed above.
2. Open **Actions → Daily Market Report Email → Run workflow** and dispatch
   it manually (`workflow_dispatch` skips the time guard).
3. Confirm the run is green and that the recipient receives an email with a
   `daily-market-report-YYYY-MM-DD.csv` attachment.
4. The generated CSV is also uploaded as a workflow artifact for 14 days.

## Local smoke test

You can exercise the email script locally without running the workflow:

```bash
export GMAIL_USERNAME='you@gmail.com'
export GMAIL_APP_PASSWORD='xxxxxxxxxxxxxxxx'   # 16 chars, no spaces
export EMAIL_TO='you@gmail.com'
export EMAIL_FROM_NAME='Daily Market Report'

npm install
npm run daily-report
```

Never commit real secret values — only set them as environment variables or
GitHub repository secrets.
