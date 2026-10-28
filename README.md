# Capstone-Group2

Source code for MIST capstone project.

The repository holds two things:

1. **ClausePilot**, a local agreement review prototype. This is the default view.
2. The **PDF text extraction harness** from Jira ticket KAN-402, kept as a
   separate view so its measurements stay reproducible.

The review screens and the extraction harness run in the browser. Behind them,
a Netlify Function serves an API backed by Netlify Database (Postgres) and a
private Netlify Blobs store, with Netlify Identity for sign-in. See
[Backend: accounts, roles and data](#backend-accounts-roles-and-data). There is
no Python.

## ClausePilot: the agreement review prototype

A local, testable first-pass workflow for vendor agreements. It can:

- accept text-based PDF and TXT agreements;
- extract PDF text in the browser;
- identify the team's **12 approved CUAD playbook categories** with local
  deterministic rules;
- attach a confidence indicator and supporting source text to every finding;
- let a reviewer accept, dismiss, escalate, or manually add findings;
- complete a review and show category-level reporting;
- switch between the Requester, Reviewer, Approver, and Administrator views
  the signed-in person's roles allow; and
- save every agreement, finding and decision through the API, so reviewers on
  any machine see the same records.

No AI service is required. **This is a prototype: do not submit real
confidential agreements.**

### Where agreements are stored

The browser extracts the text, then sends the submission to the API. Nothing
about an agreement is kept in browser storage.

| What | Where |
| ---- | ----- |
| Agreement details, extracted text, findings, decisions and notes | Netlify Database (Postgres): `agreements` and `findings` |
| The original PDF or TXT file | The private Netlify Blobs store `agreement-documents` (`agreement-documents-<context>` outside production), with a row in `agreement_documents` |
| Who did what | `audit_events` |

Findings are produced on the server, by the same playbook rules the browser
uses, so a submission cannot arrive with ready-made findings. The original file
is uploaded straight after the record is created. If that upload fails, the
agreement and its text are still saved and the confirmation says the file
wasn't stored.

## Backend: accounts, roles and data

Added in KAN-21A. Everything lives in this repository and deploys with the
site.

### Sign-in and sessions

Netlify Identity handles sign-in, sign-out, invitations and password reset
(`src/components/AuthGate.tsx`). After sign-in, `SessionGate` calls
`GET /api/session`. The server verifies the Identity token, finds or creates
the person's ClausePilot account, and returns their roles. Those roles decide
which views the "Viewing as" switcher offers.

Roles are stored in the database, not in the Identity token, so a change an
administrator makes applies on the person's very next request.

### Roles

| Role / permission | Can |
| ----------------- | --- |
| Requester         | Submit agreements, attach documents to their own new submissions, and see only their own agreements |
| Reviewer          | See every agreement, record decisions, add manual findings, and complete a review as escalated |
| Approver (permission) | Approve a completed review. Granted on top of Reviewer or Administrator, never alone |
| Administrator     | Everything a reviewer can do, plus manage accounts, roles and the Approver permission |

A newly invited person starts as a Requester. To get the first administrator,
set the **`BOOTSTRAP_ADMIN_EMAILS`** environment variable on the Netlify site
(comma-separated). Anyone signing in with one of those emails is made an
Administrator.

### Assigning roles

Administrators manage access on the **Users** page. Switch "Viewing as" to
**Administrator**, then choose **Users** in the sidebar. Each person has
checkboxes for Requester, Reviewer, Administrator, Approver and Active. Change
them, then **Save changes**.

- People appear on the page after their first sign-in. Invite them from the
  Netlify Identity dashboard first.
- Approver needs Reviewer or Administrator. Removing both also clears Approver.
- An account needs at least one role. To cut someone off, clear **Active**
  instead; that keeps their history.
- You can't remove your own Administrator role or deactivate yourself.
- A change applies from the person's next request. Someone who is already
  signed in may need to reload to see new views.

Roles set in the Netlify Identity dashboard are not used. The server checks
every change again (`PUT /api/users/:id/access`) and records it in the audit
history.

### How the data is secured

- **Row-level security.** Every API query runs inside a transaction that
  switches to the `clausepilot_app` database role and records the signed-in
  user (`server/db.ts`). Postgres policies then decide which rows that person
  can read or change, so a missing `WHERE` clause in application code cannot
  leak data. Approval, the audit trail and the Approver-requires-Reviewer rule
  are enforced by triggers as well.
- **Private documents.** Uploaded PDFs and TXT files go to a Netlify Blobs
  store that is never served publicly. The only way to read one is
  `GET /api/documents/:id`, which looks the document up through row-level
  security first. Uploads are checked by content (a PDF must start with
  `%PDF-`), capped at 25 MB, and stored under keys the server generates.
  Each deploy context has its own store, so previews never write into
  production's.
- **Server-side findings.** Submitting an agreement re-runs the playbook rules
  on the server. Findings sent by the browser are ignored.

### Migrations and seed data

Versioned SQL migrations live in `netlify/database/migrations/` and are applied
automatically on each deploy (production and deploy previews):

1. `…_create_accounts_and_roles.sql`: accounts, roles and the Approver permission
2. `…_create_agreements.sql`: agreements, findings, documents and the audit trail
3. `…_row_level_security.sql`: the application role, helper functions, policies and grants
4. `…_seed_demo_data.sql`: four demo accounts and four sample agreements
5. `…_clear_agreement_data.sql`: a clean start. Deletes every agreement, with
   its findings, document records and audit history, and keeps accounts and
   roles.
6. `…_remove_other_users.sql`: removes every account except
   `etownsend309@gmail.com` and `ejt41483@uga.edu`, with their roles. It stops
   with an error instead if an agreement was submitted, approved or given a
   file by someone it would remove. A fresh database therefore starts with no
   agreements and only those two accounts, once those two people have signed
   in.

The seeded accounts are `requester@`, `reviewer@`, `approver@` and
`admin@example.test`. Each one is claimed by whoever first signs in with that
email, and Identity is invite-only. To use them, invite those addresses from
the Netlify Identity dashboard, or change the emails in a new migration.

The API tests in `tests/integration/` apply every migration except the two
production clean-ups (5 and 6), so they still run against the demo accounts
and agreements, and test each clean-up separately.

Never edit a migration that has been deployed. Add a new one instead.

### API

| Method and path | Who |
| --------------- | --- |
| `GET /api/session` | Anyone signed in |
| `GET /api/agreements`, `GET /api/agreements/:id` | Filtered to what the person may see |
| `POST /api/agreements` | Requesters, Administrators |
| `POST /api/agreements/:id/documents`, `GET /api/documents/:id` | Upload: the submitter while new, or reviewers. Download: anyone who can see the agreement |
| `PATCH /api/findings/:id`, `POST /api/agreements/:id/findings` | Reviewers |
| `POST /api/agreements/:id/complete` | Reviewers; approving needs the Approver permission |
| `GET /api/reports/categories` | Anyone signed in; counts only the agreements the person may see |
| `GET /api/users`, `PUT /api/users/:id/access` | Administrators |

`src/lib/api.ts` is the typed browser client, and `src/shared/api.ts` holds
the types both sides share.

### Running it locally

`npm run dev` runs the front end only. `/api` is not available there, so the
workspace stops at "Loading your workspace". To run the functions and a local
database too, use the Netlify CLI:

```bash
netlify dev
netlify database migrations apply
```

Netlify Identity does not work under `netlify dev`. Test sign-in on a deploy
preview.

### The 12 approved categories

Governing Law, Anti-Assignment, Cap On Liability, Audit Rights, Termination For
Convenience, Exclusivity, Renewal Term, Insurance, Change Of Control, Uncapped
Liability, Notice Period To Terminate Renewal, Warranty Duration.

Indemnification is deliberately **not** a standalone category. The demo
agreement contains indemnification language so that Uncapped Liability has
something to match, but no finding is produced for indemnification itself.
`tests/unit/analyze.test.ts` asserts both the category list and the fact that
the demo agreement exercises all 12.

## The KAN-402 extraction harness

The capstone needs to read text out of vendor agreement PDFs. Before building
anything on that assumption, KAN-402 asked three questions:

1. How well does PDF.js read a contract PDF?
2. What happens when it cannot read one?
3. When should the team stop trying and ask for supplied plaintext instead?

The harness answers those by parsing a PDF in the browser, reconstructing the
text two different ways, measuring both, and refusing to call an empty result a
success. Findings and the provisional recommendation are in
[`docs/pdf-extraction-poc.md`](docs/pdf-extraction-poc.md); the measured numbers are in
[`artifacts/pdf-benchmark-results.md`](artifacts/pdf-benchmark-results.md).

ClausePilot uses the same engine (`src/pdf/`) through a thin adapter at
`src/lib/extractText.ts`, which also adds TXT support. The adapter prefers the
coordinate reconstruction strategy, because the benchmark shows the two
strategies tie on single-column documents while stream order interleaves the
columns of a two-column agreement.

## Requirements

- Node.js 20.19 or newer (developed on Node 22)
- npm

## Installation

```bash
git clone https://github.com/etownsend309-cmd/Capstone-Group2.git
cd Capstone-Group2
npm install
```

To run the browser tests you also need Playwright's browsers once:

```bash
npx playwright install chromium
```

## Running the app

```bash
npm run dev
```

Then open <http://127.0.0.1:5173>. The Vite dev server has no `/api`, so to use
the workspace run it under `netlify dev` as described in
[Running it locally](#running-it-locally). Choose **New agreement**, then **Load demo agreement** to fill the submission
form with sample metadata and a document. Click **Create review** to submit it
and view its reference and status in **My submissions**.

The extraction harness is at <http://127.0.0.1:5173/?view=extraction-poc>, also
reachable from the link at the bottom of the sidebar. Drop a PDF onto its upload
panel, label it, and press **Run extraction**.

To check a production build locally:

```bash
npm run build
npm run preview
```

## Commands

| Command                | What it does                                                     |
| ---------------------- | ---------------------------------------------------------------- |
| `npm run dev`          | Start the Vite dev server                                        |
| `npm run build`        | Typecheck, then build for production into `dist/`                |
| `npm run preview`      | Serve the production build                                       |
| `npm run typecheck`    | TypeScript with no emit, across app and scripts                  |
| `npm run lint`         | ESLint checks application, scripts, config and test code         |
| `npm run lint:fix`     | Apply safe automated ESLint fixes                               |
| `npm test`             | Vitest: unit, component, and API-plus-database integration tests |
| `npm run test:e2e`     | Playwright browser tests                                         |
| `npm run test:e2e:landing` | Chromium smoke test of the default landing page and browser errors |
| `npm run fixtures`     | Regenerate the test PDFs in `fixtures/generated/`                |
| `npm run benchmark`    | Measure every fixture and rewrite `artifacts/pdf-benchmark-results.{json,md}` |

### Why the fixtures are committed

`fixtures/generated/` is checked in rather than built on demand, so `npm test`
works on a fresh clone and the benchmark numbers describe the same documents
everyone else has.

Generation is deterministic: the document timestamps are pinned in
`scripts/generateFixtures.ts`, so `npm run fixtures` reproduces byte-identical
files. If regenerating ever does change them, the content genuinely changed, and
the benchmark should be re-run so `artifacts/` stays consistent.

### Two layers of test, on purpose

`npm test` covers the playbook rules, the extraction logic against the real
fixture PDFs, the harness UI rendered under jsdom, and the API. The API tests
(`tests/integration/`) apply the real migrations to Netlify's in-process
Postgres (PGlite) and call the same handler the Netlify Function uses, so they
exercise the row-level security policies. It needs nothing but Node.

`npm run test:e2e` covers the same UI behaviour in a real browser, where a real
PDF.js worker and real file downloads are involved. It needs a browser, so it is
kept separate rather than being the only thing that verifies the interface.

`npm run test:e2e` runs all configured projects unless one is selected:
`--project=chromium`,
`--project=firefox`, or `--project=chrome` to drive a Google Chrome that is
already installed instead of downloading Playwright's own Chromium — useful on a
machine or network that cannot reach the Playwright CDN.

## KAN-29 quality checks

ESLint uses the JavaScript and TypeScript recommended flat configurations.
Application files use browser globals; scripts, configuration and test files
use Node globals. Dependencies, build output, reports and PDF fixtures are
excluded. Warnings fail `npm run lint`; TypeScript remains a separate check.

The landing-page test opens `/` in an isolated Playwright context, verifies
the overview heading, navigation, summary, empty state and eight workflow
stages, and fails on console errors or uncaught page exceptions. Error listeners
are attached before navigation. This test does not replace the extraction suite.

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e:landing
```

If the browser CDN is unavailable but Google Chrome is installed, use
`npm run test:e2e -- tests/e2e/landing.spec.ts --project=chrome`.
Listing tests with `--list` verifies discovery only, not a browser pass.

The `KAN-29 checks` GitHub Actions workflow runs a clean installation, lint,
TypeScript checks, unit/component tests, the production build and the Chromium
landing-page test on pushes and pull requests. Results appear in the repository's
Actions tab. The workflow can also be started manually with **Run workflow**.

The KAN-29 ESLint configuration and landing-page test were predominantly
AI-generated with ChatGPT Codex for Nadia Densu. Record module ownership and
comprehension review in the KAN-72 provenance log.

## Technology stack

| Purpose             | Choice                                    |
| ------------------- | ----------------------------------------- |
| UI                  | React 19 + TypeScript 5.9                 |
| Build / dev server  | Vite 7                                    |
| PDF parsing         | `pdfjs-dist` 6.3.289 (PDF.js, legacy build) |
| Unit and component tests | Vitest 5 (Node, plus jsdom for components) |
| Browser tests       | Playwright                                |
| API                 | Netlify Functions (`netlify/functions/api.mts`) |
| Sign-in             | Netlify Identity (`@netlify/identity`)    |
| Database            | Netlify Database (Postgres), raw SQL with row-level security |
| Document storage    | Netlify Blobs, private                    |
| Fixture generation  | `pdf-lib` and `jimp`                      |

The PDF.js **`legacy`** build is used in both the browser and the Node scripts.
Using one build means the benchmark measures the same code path the app runs.

## Layout

```
src/App.tsx       ClausePilot: shell, intake, review queue, decisions, reports
src/lib/          Playbook analyzer and the extraction adapter
src/pdf/          PDF.js driver, the two reconstruction strategies, measurement, report
src/poc/          The KAN-402 extraction harness and its components
scripts/          Fixture generator and benchmark runner (TypeScript, run with tsx)
src/shared/       Types shared by the browser and the API
server/           API routing, request-scoped database access, services
netlify/functions/   The /api Netlify Function
netlify/database/migrations/  Versioned SQL migrations, seed data included
tests/unit/       Vitest: pure functions, real-fixture extraction, jsdom component tests
tests/integration/   Vitest: the API against a local Postgres
tests/e2e/        Playwright browser tests
fixtures/generated/  Committed synthetic PDFs plus their expected text
fixtures/private/    Git-ignored space for approved local PDFs
artifacts/        Committed benchmark output
docs/             Written findings
```

The two views own separate global stylesheets that both style `body`, `button`,
and `.panel`. `src/main.tsx` imports one view and its stylesheet on demand so
the two never collide.

### A note on `index.html`

The repository's original `index.html` landing page is now the Vite entry point,
because Vite requires `index.html` at the project root. Its original sentence is
preserved inside the `<noscript>` block, so it is still what a visitor sees
without JavaScript.

## Testing a private or real PDF

Put it in `fixtures/private/`, which is git-ignored, and follow
[`fixtures/private/README.md`](fixtures/private/README.md). Automated tests use
only `fixtures/generated/`.

## Privacy

This is for local evaluation only.

- Text is extracted from PDFs in the browser. On submission, ClausePilot sends
  the details and extracted text to the database and the original file to a
  private Netlify Blobs store (see
  [Where agreements are stored](#where-agreements-are-stored)). Anyone allowed
  to see the agreement can read them.
- Extracted text is never logged. Developer diagnostics go to `console.debug`
  and carry no document content.
- The extraction harness stores nothing. Resetting or reloading discards its
  PDF.
- Exported harness reports contain metrics and your notes, not extracted text,
  unless you explicitly opt in — and then only a 300-character excerpt.
- Do not commit real agreements. `fixtures/private/`, `artifacts/local/`, and
  exported `pdf-extraction-report-*` files are git-ignored.

## Known limitations

### The review workflow

- **Rule confidence values are prototype indicators,** not evaluated model
  scores. They are fixed constants per category.
- **One finding per category.** The analyzer stops at the first pattern that
  matches, so a second occurrence elsewhere in the document is not flagged.
- **Roles limit the switcher, and the API enforces them.** The view switcher
  only hides controls; every action is checked again by the API and the
  database, and a refusal is shown on screen.
- **Large files may not upload.** The API accepts files up to 25 MB, but
  Netlify Functions limit the size of a request body. A file over that limit
  is submitted without its original; the confirmation says so.
- **The lists refresh when you change views,** not live. Someone else's
  decision appears the next time you open the queue or the agreement.
- **Not wired yet:** an AI classifier.

### Extraction

- **No OCR.** PDF.js reads a PDF's existing text layer. A scanned or
  image-only PDF has none, so extraction correctly returns nothing and the
  reviewer is told why. OCR is a separate technology decision; see the OCR
  research note in [`docs/pdf-extraction-poc.md`](docs/pdf-extraction-poc.md).
- **Two strategies, one engine.** Both strategies read the same PDF.js parse.
  They compare ways of *reconstructing* text, not competing PDF engines.
- **The coordinate strategy is an experiment,** not a layout engine. It handles
  one column gutter per page; tables and rotated text are not reconstructed
  faithfully.
- **The low-text threshold is a heuristic** (fewer than 50 printable characters
  per page), not a confidence score.
- **Character count measures volume, not quality.** The multi-column fixture
  produces identical counts from both strategies in completely different reading
  orders.
- **No password-protected PDF support.** Encrypted files are reported as a
  failure with the fallback offered.
- **Not production architecture.** No authentication, no persistence beyond the
  browser, no deployment.
