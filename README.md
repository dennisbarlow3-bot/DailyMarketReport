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

## What the report screens for

> **Not financial advice.** The CSV is a transparent, deterministic,
> rules-based screen on top of free, public Yahoo Finance data.

Each business day the report picks **up to 20 Nasdaq 100 stocks** that:

1. Had the **largest one-day price drop** (ranked by
   `regularMarketChangePercent`, most negative first), and
2. Pass a **baseline quality filter** (positive market cap above
   `MIN_MARKET_CAP`, volume above `MIN_VOLUME`, and an actual decline today),
   and
3. Are surfaced with a **growth-tilted composite score** so the names that
   surface are oversold *growth* companies rather than indiscriminate
   decliners.

### Scoring model

Three component scores, each on `[0, 1]`, are combined into a `total_score`:

- **`rebound_score`** — `0.55 × drop` + `0.25 × analyst upside` +
  `0.20 × buy-recommendation`. The size of today's drop is the dominant
  factor; analyst upside and a bullish mean recommendation add conviction
  that the move is reversible.
- **`growth_score`** — `0.45 × revenue growth` + `0.30 × earnings growth` +
  `0.25 × profit margin`. Implements the **growth tilt** the user asked for.
- **`quality_score`** — `0.35 × (1 − debt/equity)` + `0.25 × log-scaled
  market cap` + `0.20 × current ratio` + `0.20 × return on equity`. Rewards
  healthy balance sheets, scale, and liquidity.

`total_score = 0.50 × rebound + 0.30 × growth + 0.20 × quality`. Rows are
sorted primarily by the **largest one-day decline** (most negative
`one_day_change_pct`), with `total_score` as a tie-breaker — so the biggest
qualifying decliners always surface first.

### Data sources

`scripts/generate-report.js` pulls data from two public Yahoo Finance
endpoints. **No API key, no third-party npm dependencies** — only Node's
built-in `https` module:

- `query1.finance.yahoo.com/v8/finance/chart/{symbol}` — live quote, price,
  previous close, volume.
- `query1.finance.yahoo.com/v10/finance/quoteSummary/{symbol}` — market
  cap, revenue growth, profit margins, EPS, debt/equity, analyst target
  price, mean recommendation, etc. Requires a one-time **crumb + cookie
  handshake** against `fc.yahoo.com` and `/v1/test/getcrumb` — the script
  performs this automatically.

### Universe

**Default:** the **Nasdaq 100** constituents, embedded as
`DEFAULT_NDX_100` at the top of `scripts/generate-report.js`. Update that
array when Nasdaq rebalances the index (typically annually in December).

**Override** at runtime — useful for local testing or running on a custom
list — by setting the `TICKERS` environment variable to a comma-separated
list of Yahoo Finance symbols:

```bash
TICKERS="AAPL,MSFT,NVDA" npm run generate:report
```

In the GitHub Actions workflow, add `TICKERS:` under the *Generate report*
step's `env:` block to override on scheduled runs.

### Configuration via environment variables

All optional; defaults match the user-selected requirements.

| Variable          | Default       | Purpose                                                |
| ----------------- | ------------- | ------------------------------------------------------ |
| `TICKERS`         | Nasdaq 100    | Comma-separated universe override.                     |
| `OUTPUT_COUNT`    | `20`          | Maximum rows in the CSV body.                          |
| `MIN_MARKET_CAP`  | `2000000000`  | Minimum market cap in USD ($2B) for baseline filter.   |
| `MIN_VOLUME`      | `100000`      | Minimum regular-market volume.                         |
| `MAX_CHANGE_PCT`  | `0`           | Only rank names with `change_pct < this` (drops only). |

### CSV columns

`rank`, `symbol`, `name`, `price`, `one_day_change_pct`, `one_day_change`,
`volume`, `market_cap`, `revenue_growth`, `profit_margins`, `trailing_eps`,
`forward_eps`, `debt_to_equity`, `target_mean_price`, `analyst_upside_pct`,
`recommendation_mean`, `quality_score`, `growth_score`, `rebound_score`,
`total_score`, `generated_at` (ISO 8601 UTC), `notes`.

The `notes` column explains why each name qualified ("one-day drop -3.42%;
revenue growth 18.0%; profit margin 22.1%; analyst upside 14.5%; rec mean
1.80") and flags any missing fundamentals.

CSV values are properly escaped (entries containing commas, quotes, or
newlines are quoted). Missing values render as empty cells. The run
**fails if no rows qualify** so the workflow never emails an empty report.
If fewer than `OUTPUT_COUNT` names qualify (e.g. broad rally with few
decliners), the available qualified rows are written and a warning is
printed to stderr.

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
