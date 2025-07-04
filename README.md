# Email Auto-Responder & Bookings Management

A full-stack automated email processing and bookings management system, designed for tour operators. It parses booking emails, stores bookings in a Postgres database, provides a modern web UI for management, and sends notifications via Email, Telegram, and LINE. Built for Vercel serverless deployment.

---

## Features
- **Automated Email Parsing:** Extracts booking details from Bokun.io and Thailand Tours emails.
- **Bookings Table UI:** Modern, responsive table with search, sort, pagination, and status toggles, and Book Date column.
- **Summary Stats:** Shows total, tomorrow, and day after tomorrow's bookings (Bangkok time), including unsent notifications. Summary cards always in sync with table and time. Percent change is displayed for all metrics, including Total Bookings.
- **Multi-Channel Notifications:** Sends booking notifications via Email, Telegram, and LINE.
- **Timezone-Aware:** All date logic uses Asia/Bangkok timezone for accuracy, both in backend (Postgres SQL, Node.js) and frontend (UI, summary, search). Robust handling ensures summary cards, table, and search are always in sync with Bangkok time.
- **API Endpoints:** RESTful endpoints for bookings, toggles, and notifications.
- **Daily Scheduler:** Endpoint for scheduled notification jobs (e.g., via Vercel cron or external scheduler).
- **Accounting table:**
  - Toggle between Bookings and Accounting views
  - Shows only relevant columns (booking number, date, customer, program, hotel, paid)
  - **Summary cards** for Last Month and This Month: total bookings and total paid
  - **Inline edit**: Click the Paid cell to add or update the value, saved instantly
  - Click summary cards to filter table by month
  - Search, sort, and pagination supported
- **Programs (Tours) Management:**
  - Modern, pixel-perfect Programs tab with table and nested rates (matches design example)
  - Add Program form with dynamic rate items, supports multiple rates per program
  - Product ID (Optional) field mapped to `product_id_optional` and shown in the table
  - CRUD for programs and rates, with validation and clean UI
- **Dashboard:**
  - Robust error handling for missing percent change elements (see Troubleshooting)
  - All dashboard metrics and percent changes require their respective DOM elements
  - Percent change for Total Bookings metric
- **Server Time Debug Endpoint:** `/api/server-time` returns current server time, UTC, and formatted Bangkok time for debugging timezone issues on Vercel.

---

## Troubleshooting
- **Dashboard JavaScript Error (bookingsChange is not defined):**
  - Ensure the following elements exist in your dashboard section:
    - `<div id="dashboard-total-bookings-change"></div>`
    - `<div id="dashboard-new-bookings-change"></div>`
    - `<div id="dashboard-total-earnings-change"></div>`
  - If missing, add them directly under the main value for each metric card.
  - Hard refresh your browser after redeploying.
- **Add Program form not showing:**
  - This is usually caused by a JavaScript error earlier in the script (see above).
  - Fix dashboard errors first, then the Add Program button will work.
- **Redeploying:**
  - For Vercel: Go to your project dashboard, click "Deployments" > "Redeploy".
  - For Netlify: Go to your site dashboard, click "Deploys" > "Trigger deploy" > "Deploy site".
  - For custom servers: `git pull` and restart your server.

---

## Setup
1. **Clone the repository:**
   ```sh
   git clone https://github.com/majidorc/parse-email.git
   cd parse-email
   ```
2. **Install dependencies:**
   ```sh
   npm install
   ```
3. **Configure environment variables:**
   - Copy `.env.example` to `.env` and fill in your credentials for Postgres, SMTP, Telegram, and LINE.
   - Set up `config.json` for parser rules and notification channel toggles.
4. **Deploy:**
   - Deploy to Vercel for serverless operation, or run locally with `npm start` (for development/testing).

---

## Configuration
- **[config.json](./config.json)**
  - `parserRules`: Maps sender addresses to parser classes.
  - `notifications`: Enable/disable email, Telegram, and LINE notifications.
- **Environment Variables:**
  - `POSTGRES_URL`, `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_USER_ID`, etc.

---

## API Endpoints
- `GET /api/bookings` — List bookings (with pagination, search, sort, summary stats, and Book Date)
- `PATCH /api/bookings/[booking_number]` — Toggle OP/RI/Customer status for a booking
- `POST /api/toggle-op-customer` — Alternate toggle endpoint (legacy)
- `POST /api/webhook` — Main email parser and booking ingester
- `POST /api/daily-scheduler` — Run daily notification job (requires secret)
- `POST /api/line-webhook` — Handle LINE bot postbacks for toggles
- `/api/accounting` supports GET (with search, sort, pagination) and PATCH (to update paid value)

---

## Notification Channels
- **Email:** Sends booking details to configured recipients.
- **Telegram:** Sends booking details and interactive buttons to a Telegram chat.
- **LINE:** Sends booking details and interactive buttons to a LINE user.
- All channels can be enabled/disabled in `config.json` and via environment variables.

---

## Frontend Usage
- Open [`public/index.html`](./public/index.html) in your browser (or deploy as static frontend).
- Features:
  - Search, sort, and paginate bookings
  - Toggle OP/RI/Customer status with one click
  - See summary stats for tomorrow and day after tomorrow (Bangkok time)
  - Book Date column shown in bookings and accounting tables
  - Color-coded rows for past (red), today (green), and tomorrow (yellow) — applies to both desktop table and mobile cards
  - All rows are bold for better readability
  - Copy button copies all booking details, including phone number
  - Live Bangkok date and time is shown at the top of the main card for reference
  - Bookings/Accounting toggle buttons are inside the main card for a cleaner UI
  - **Programs (Tours) Management:**
    - Programs tab with inline-editable table for CRUD (create, read, update, delete) of tour programs
    - Product ID (Optional) field mapped to `product_id_optional` and shown under SKU
    - Rate dropdown with "-- Add New Item --" and custom entry support
    - Rates table: auto-fill net prices for adult/child, add new rates inline
    - NP (Net Price) logic: NP Adult/Child fields only enabled when NP is checked, robust save logic
    - Bugfix: Saving a Program never overwrites remark with np_adult/np_child values
  - **Mobile UI:** Bookings cards only show on Bookings tab (never on Dashboard, Programs, or Accounting)
  - All debug `console.log` and `console.debug` statements removed for clean production output
  - Robust upsert logic for bookings and programs, improved UI/UX, and bugfixes

---

## Deployment
- **Vercel:**
  - All API endpoints are serverless functions under `/api`.
  - Configure [`vercel.json`](./vercel.json) for function timeouts.
  - Deploy with `vercel --prod`.
- **Local:**
  - Run `npm start` for local development (requires Node.js 18+).

---

## License
ISC 

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for a full version history and recent updates. 

## Usage
- Deploy backend (Node.js/Express, PostgreSQL)
- Deploy frontend (static HTML/JS in `public/`)
- Use the toggle to switch between Bookings and Accounting
- In Accounting view:
  - Click the Paid cell to edit/add a value
  - Click Last Month/This Month cards to filter
  - Use the search bar to filter by customer, program, etc.
  - Clear search to reset results 