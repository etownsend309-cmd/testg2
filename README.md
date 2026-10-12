# Capstone-Group2

Source code for MIST capstone project.

The repository holds two things:

1. **ClausePilot**, a local agreement review prototype. This is the default view.
2. The **PDF text extraction harness** from Jira ticket KAN-402, kept as a
   separate view so its measurements stay reproducible.

Both run entirely in the browser. There is no backend, no database, and no
Python.

## ClausePilot: the agreement review prototype

A local, testable first-pass workflow for vendor agreements. It can:

- accept text-based PDF and TXT agreements;
- extract PDF text in the browser;
- identify the team's **12 approved CUAD playbook categories** with local
  deterministic rules;
- attach a confidence indicator and supporting source text to every finding;
- let a reviewer accept, dismiss, escalate, or manually add findings;
- complete a review and show category-level reporting;
- switch between Requester, Reviewer, Approver, and Administrator views; and
- keep its records in browser storage, so nothing leaves the machine.

No AI service or backend is required. **Prototype records are kept in browser
storage, so do not use real confidential agreements.**

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

Then open <http://127.0.0.1:5173>. Choose **Load demo agreement** to exercise
the full workflow without supplying a file.

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
| `npm test`             | Vitest: unit and component tests                                 |
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
fixture PDFs, and the harness UI rendered under jsdom. It needs nothing but
Node.

`npm run test:e2e` covers the same UI behaviour in a real browser, where a real
PDF.js worker and real file downloads are involved. It needs a browser, so it is
kept separate rather than being the only thing that verifies the interface.

`npm run test:e2e` accepts a browser project: `--project=chromium` (default),
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
tests/unit/       Vitest: pure functions, real-fixture extraction, jsdom component tests
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

- PDFs are processed in the browser. There is no server to upload them to.
- Extracted text is never logged. Developer diagnostics go to `console.debug`
  and carry no document content.
- No uploaded PDF is stored. Resetting or reloading discards it.
- ClausePilot keeps agreement records, including extracted text, in this
  browser's `localStorage`. Clear site data to remove them.
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
- **Browser storage only.** Records live in `localStorage`, are not shared
  between browsers or machines, and have no migration path.
- **No authentication or access control.** The role switcher changes what the
  interface offers; it does not enforce anything.
- **Not wired yet:** database persistence, server-side access control, and an
  AI classifier.

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
