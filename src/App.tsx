import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./components/Icon";
import { Intake } from "./components/Intake";
import { api } from "./lib/api";
import { playbook } from "./lib/analyze";
import {
  STATUS_LABELS,
  type AgreementDetail,
  type AgreementStatusCode,
  type AgreementSummary,
  type CategoryReport,
  type FindingDecisionCode,
  type FindingRecord,
  type NewAgreementInput,
} from "./shared/api";
import type { Role, View } from "./types";

const formatDate = (date: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(date));

const today = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
}).format(new Date());

const OPEN_STATUSES: AgreementStatusCode[] = ["needs_review", "in_review"];
const isOpen = (agreement: Pick<AgreementSummary, "status">) => OPEN_STATUSES.includes(agreement.status);

const METHOD_LABELS: Record<FindingRecord["method"], string> = { local_rule: "Local rule", manual: "Manual" };

const errorMessage = (reason: unknown, fallback: string) => (reason instanceof Error && reason.message ? reason.message : fallback);

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

/** A detail record narrowed to the fields the list views keep. */
function toSummary(detail: AgreementDetail): AgreementSummary {
  return {
    id: detail.id,
    name: detail.name,
    vendor: detail.vendor,
    agreementType: detail.agreementType,
    businessUnit: detail.businessUnit,
    neededBy: detail.neededBy,
    submittedBy: detail.submittedBy,
    submittedAt: detail.submittedAt,
    status: detail.status,
    completedAt: detail.completedAt,
    approvedAt: detail.approvedAt,
    findingCount: detail.findings.length,
    pendingFindingCount: detail.findings.filter((finding) => finding.decision === "pending").length,
  };
}

function StatusPill({ status }: { status: AgreementStatusCode }) {
  const label = STATUS_LABELS[status];
  return <span className={`status status-${label.toLowerCase().replaceAll(" ", "-")}`}>{label}</span>;
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <div className="empty-icon"><Icon name="file" /></div>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

type ListState = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

interface AppProps {
  /** The signed-in person's ClausePilot account (from the API session), not their Identity user. */
  user: { id: string; email: string };
  /** The workspace views this person's roles allow, from the API session (see availableViews). */
  views: Role[];
  displayName?: string;
  onSignOut: () => void;
}

export default function App({ user, views, displayName, onSignOut }: AppProps) {
  const [view, setView] = useState<View>("overview");
  // Start in the most review-oriented view the person holds, as the app
  // always has; the switcher only ever offers views they are entitled to.
  const [chosenRole, setRole] = useState<Role | undefined>(undefined);
  const role: Role =
    chosenRole && views.includes(chosenRole) ? chosenRole : (views.find((v) => v === "Reviewer") ?? views[0] ?? "Requester");

  const [agreements, setAgreements] = useState<AgreementSummary[]>([]);
  const [listState, setListState] = useState<ListState>({ kind: "loading" });
  const [details, setDetails] = useState<Record<string, AgreementDetail>>({});
  const [detailError, setDetailError] = useState("");
  const [activeAgreementId, setActiveAgreementId] = useState<string>();
  const [inFlight, setInFlight] = useState(0);
  /** Review actions run one at a time, in the order they were asked for. */
  const actionQueue = useRef<Promise<unknown>>(Promise.resolve());

  const [notice, setNotice] = useState("");
  const [saveError, setSaveError] = useState("");

  /**
   * Whether this session is still on screen.
   *
   * Signing out unmounts App, but a submission whose text is still being
   * extracted keeps running. Once it finishes it must not send the agreement
   * under whatever session the browser has by then. Set on mount, not just
   * initialised, because StrictMode runs the cleanup once before the real mount.
   */
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  /** Keeps the list and the cached detail in step with the server's latest copy of one agreement. */
  const applyDetail = useCallback((detail: AgreementDetail) => {
    if (!live.current) return;
    const summary = toSummary(detail);
    setDetails((current) => ({ ...current, [detail.id]: detail }));
    setAgreements((current) =>
      current.some((item) => item.id === detail.id)
        ? current.map((item) => (item.id === detail.id ? summary : item))
        : [summary, ...current],
    );
  }, []);

  const loadList = useCallback(async () => {
    try {
      const list = await api.listAgreements();
      if (!live.current) return;
      setAgreements(list);
      setListState({ kind: "ready" });
    } catch (reason) {
      if (!live.current) return;
      setListState({ kind: "error", message: errorMessage(reason, "Couldn't load agreements.") });
    }
  }, []);

  // Other people review and submit too, so refresh whenever a list view opens.
  useEffect(() => {
    if (view !== "intake") void loadList();
  }, [view, loadList]);

  const activeId = agreements.some((item) => item.id === activeAgreementId) ? activeAgreementId : agreements[0]?.id;
  const activeDetail = activeId ? details[activeId] : undefined;

  // Fetch the open agreement whenever it changes, showing any cached copy meanwhile.
  useEffect(() => {
    if (view !== "review" || !activeId) return;
    let current = true;
    setDetailError("");
    api.getAgreement(activeId).then(
      (detail) => {
        if (current) applyDetail(detail);
      },
      (reason) => {
        if (current && live.current) setDetailError(errorMessage(reason, "Couldn't open this agreement."));
      },
    );
    return () => {
      current = false;
    };
  }, [view, activeId, applyDetail]);

  const openReview = (id: string) => {
    setActiveAgreementId(id);
    setView("review");
  };

  const submitAgreement = async (input: NewAgreementInput, file: File) => {
    if (!live.current) {
      throw new Error("You were signed out before this submission finished, so it was not saved. Sign in and submit it again.");
    }
    let created: AgreementDetail;
    try {
      created = await api.submitAgreement(input);
    } catch (reason) {
      throw new Error(`${errorMessage(reason, "The agreement could not be saved.")} Your submission was not saved.`, { cause: reason });
    }

    // The record and its findings are saved; keeping the original file is a
    // second request, so a failure there is reported but doesn't undo the submission.
    let uploadNote = "";
    try {
      await api.uploadDocument(created.id, file);
    } catch (reason) {
      uploadNote = ` The original file wasn't stored (${errorMessage(reason, "upload failed")}), but the extracted text was saved.`;
    }
    if (!live.current) return;

    applyDetail(created);
    // The cached copy predates the upload, so the review screen fetches it again.
    setDetails((current) => withoutKey(current, created.id));
    setNotice(`Agreement "${created.name}" submitted successfully. Reference: ${created.id}. Status: ${STATUS_LABELS[created.status]}.${uploadNote}`);
    setView("tracker");
  };

  /**
   * Runs one review action against the server and shows the result or the
   * reason it failed. Actions are queued rather than refused while another is
   * in flight: leaving the note field saves the note, and the click that moved
   * focus away must still count once that save is done.
   */
  const runAction = (action: () => Promise<AgreementDetail>): Promise<AgreementDetail | undefined> => {
    setInFlight((count) => count + 1);
    const run = actionQueue.current.then(async () => {
      if (live.current) setSaveError("");
      try {
        const detail = await action();
        applyDetail(detail);
        return detail;
      } catch (reason) {
        if (live.current) setSaveError(errorMessage(reason, "The review could not be saved."));
        return undefined;
      } finally {
        if (live.current) setInFlight((count) => count - 1);
      }
    });
    actionQueue.current = run;
    return run;
  };

  const startIntake = () => {
    setNotice("");
    setSaveError("");
    setView("intake");
  };

  const navigate = (next: View) => {
    setSaveError("");
    setView(next);
  };

  const pending = agreements.filter(isOpen).length;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate("overview")}>
          <span className="brand-mark"><Icon name="shield" /></span>
          <span>Clause<span>Pilot</span></span>
        </button>
        <nav aria-label="Primary navigation">
          <NavButton active={view === "overview"} icon="home" label="Overview" onClick={() => navigate("overview")} />
          <NavButton active={view === "intake"} icon="upload" label="New agreement" onClick={() => startIntake()} />
          <NavButton active={view === "tracker"} icon="file" label="My submissions" onClick={() => navigate("tracker")} />
          <NavButton active={view === "review"} icon="review" label="Review queue" count={pending} onClick={() => navigate("review")} />
          <NavButton active={view === "reports"} icon="reports" label="Reports" onClick={() => navigate("reports")} />
        </nav>
        <div className="sidebar-note">
          <span className="eyebrow">Prototype mode</span>
          <p>Agreements are saved to the ClausePilot database. No contract is sent to an AI service.</p>
          <a href="?view=extraction-poc">Extraction test harness →</a>
        </div>
        <div className="sidebar-note sidebar-account">
          <span className="eyebrow">Signed in</span>
          {displayName && <p className="account-name">{displayName}</p>}
          <p>{user.email}</p>
          <button type="button" className="sign-out-link" onClick={onSignOut}>Sign out</button>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <p className="workspace-name">Calder Legal Operations</p>
            <p className="workspace-subtitle">Vendor agreement review</p>
          </div>
          <label className="role-switcher">
            <span>Viewing as</span>
            <select value={role} onChange={(event) => setRole(event.target.value as Role)} disabled={views.length < 2}>
              {views.map((option) => <option key={option}>{option}</option>)}
            </select>
          </label>
        </header>

        <div className="page-wrap">
          {/*
            Stays mounted so only its contents change. Inserting a live region
            and its text in the same update generally is not announced, because
            a screen reader has to be observing the region before the change.
            The intake form owns the only `role="alert"`, so this stays
            `role="status"` rather than becoming a second alert region.
          */}
          <div role="status">{notice && <p className="permission-banner">{notice}</p>}</div>
          {saveError && <p className="error-message" role="alert">{saveError}</p>}
          {view !== "intake" && view !== "reports" && listState.kind !== "ready" ? (
            <ListPlaceholder state={listState} onRetry={() => { setListState({ kind: "loading" }); void loadList(); }} />
          ) : (
            <>
              {view === "tracker" && <RequesterTracker agreements={agreements.filter((item) => item.submittedBy.id === user.id)} />}
              {view === "overview" && (
                <Overview agreements={agreements} onNew={() => startIntake()} onReview={openReview} />
              )}
              {view === "intake" && <Intake onSubmit={submitAgreement} />}
              {view === "review" && (
                <ReviewQueue
                  agreements={agreements}
                  activeId={activeId}
                  detail={activeDetail}
                  detailError={detailError}
                  role={role}
                  busy={inFlight > 0}
                  onSelect={setActiveAgreementId}
                  onDecide={(findingId, decision, note) => runAction(() => api.decideFinding(findingId, { decision, note }))}
                  onAddManual={(agreementId, category, sourceText) => runAction(() => api.addManualFinding(agreementId, { category, sourceText }))}
                  onComplete={(agreementId) => runAction(() => api.completeReview(agreementId))}
                  onNew={() => startIntake()}
                />
              )}
              {view === "reports" && <Reports />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function ListPlaceholder({ state, onRetry }: { state: ListState; onRetry: () => void }) {
  if (state.kind === "error") {
    return (
      <div className="panel">
        <EmptyState title="Couldn't load agreements" body={state.message} />
        <div className="center-action"><button className="primary-button" onClick={onRetry}>Try again</button></div>
      </div>
    );
  }
  // Not a live region: the notice above is the page's only status region.
  return <p className="empty-state">Loading agreements…</p>;
}

function NavButton({
  active,
  icon,
  label,
  count,
  onClick,
}: {
  active: boolean;
  icon: "home" | "upload" | "review" | "reports" | "file";
  label: string;
  count?: number;
  onClick: () => void;
}) {
  // Below 760px the stylesheet hides both the label and the count badge to fit
  // the nav into a row of icons, and the icon itself is aria-hidden. Without an
  // explicit name these buttons are unnamed at that width, and the pending
  // count disappears from the accessibility tree entirely.
  return (
    <button
      className={`nav-item ${active ? "active" : ""}`}
      onClick={onClick}
      aria-label={count ? `${label}, ${count} pending` : label}
    >
      <Icon name={icon} />
      <span>{label}</span>
      {!!count && <strong>{count}</strong>}
    </button>
  );
}

function Overview({
  agreements,
  onNew,
  onReview,
}: {
  agreements: AgreementSummary[];
  onNew: () => void;
  onReview: (id: string) => void;
}) {
  const open = agreements.filter(isOpen);
  const approved = agreements.filter((item) => item.status === "approved").length;
  const escalated = agreements.filter((item) => item.status === "escalated").length;

  return (
    <>
      <section className="hero">
        <div>
          <span className="eyebrow">{today}</span>
          <h1>Make the first pass count.</h1>
          <p>Surface the agreements that need legal attention and keep every decision tied to its source.</p>
        </div>
        <button className="primary-button" onClick={onNew}><span>＋</span> New agreement</button>
      </section>

      <section className="metric-grid" aria-label="Agreement summary">
        <Metric label="Total agreements" value={agreements.length} note="Visible to you" tone="navy" />
        <Metric label="Awaiting review" value={open.length} note="Needs a reviewer" tone="amber" />
        <Metric label="Approved" value={approved} note="Review completed" tone="green" />
        <Metric label="Escalated" value={escalated} note="Needs an approver" tone="red" />
      </section>

      <section className="content-grid">
        <div className="panel recent-panel">
          <div className="panel-heading">
            <div><span className="eyebrow">Work queue</span><h2>Recent agreements</h2></div>
            <button className="text-button" onClick={onNew}>Add agreement →</button>
          </div>
          {agreements.length ? (
            <div className="agreement-list">
              {agreements.slice(0, 5).map((agreement) => (
                <button key={agreement.id} className="agreement-row" onClick={() => onReview(agreement.id)}>
                  <span className="file-tile"><Icon name="file" /></span>
                  <span className="agreement-main"><strong>{agreement.name}</strong><small>{agreement.vendor} · {formatDate(agreement.submittedAt)}</small></span>
                  <span className="finding-count">{agreement.findingCount} findings</span>
                  <StatusPill status={agreement.status} />
                  <span className="row-arrow">→</span>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState title="No agreements yet" body="Load the demo or upload a PDF to test the review workflow." />
          )}
        </div>

        <div className="panel workflow-panel">
          <div className="panel-heading"><div><span className="eyebrow">Baseline workflow</span><h2>Eight-stage path</h2></div></div>
          <ol className="workflow-list">
            {["Intake", "Ingest & segment", "Identify provisions", "Generate flags", "Human review", "Disposition", "Record decision", "Report"].map((step, index) => (
              <li key={step}><span>{index + 1}</span><div><strong>{step}</strong><small>{index < 4 ? "Prototype ready" : "Ready to test"}</small></div></li>
            ))}
          </ol>
        </div>
      </section>
    </>
  );
}

function Metric({ label, value, note, tone }: { label: string; value: number; note: string; tone: string }) {
  return (
    <article className={`metric-card metric-${tone}`}>
      <span>{label}</span><strong>{value.toString().padStart(2, "0")}</strong><small>{note}</small>
    </article>
  );
}

function RequesterTracker({ agreements }: { agreements: AgreementSummary[] }) {
  return <section>
    <div className="page-heading"><span className="eyebrow">Requester tracker</span><h1>My submissions</h1><p>Track the agreements you have submitted and where each review stands.</p></div>
    {agreements.length === 0 ? <EmptyState title="No submissions yet" body="Submit an agreement to track its status here." /> :
      <div className="agreement-list">{agreements.map((agreement) => <article className="panel tracker-record" key={agreement.id}>
        <h2>{agreement.name}</h2><StatusPill status={agreement.status} />
        <dl>
          <dt>Reference</dt><dd>{agreement.id}</dd>
          <dt>Vendor</dt><dd>{agreement.vendor}</dd>
          <dt>Agreement type</dt><dd>{agreement.agreementType || "Not recorded"}</dd>
          <dt>Business unit</dt><dd>{agreement.businessUnit || "Not recorded"}</dd>
          <dt>Needed-by date</dt><dd>{agreement.neededBy || "Not recorded"}</dd>
          <dt>Submitted</dt><dd>{formatDate(agreement.submittedAt)}</dd>
        </dl>
      </article>)}</div>}
  </section>;
}

function ReviewQueue({
  agreements,
  activeId,
  detail,
  detailError,
  role,
  busy,
  onSelect,
  onDecide,
  onAddManual,
  onComplete,
  onNew,
}: {
  agreements: AgreementSummary[];
  activeId?: string;
  detail?: AgreementDetail;
  detailError: string;
  role: Role;
  busy: boolean;
  onSelect: (id: string) => void;
  onDecide: (findingId: string, decision: FindingDecisionCode, note: string) => Promise<AgreementDetail | undefined>;
  onAddManual: (agreementId: string, category: string, sourceText: string) => Promise<AgreementDetail | undefined>;
  onComplete: (agreementId: string) => Promise<AgreementDetail | undefined>;
  onNew: () => void;
}) {
  const [activeFindingId, setActiveFindingId] = useState<string>();
  const [manualCategory, setManualCategory] = useState(playbook[0].name);
  /** Notes typed but not yet saved, by finding. A note is saved with the next decision, or when the field loses focus. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Guards against a double click adding two findings or completing twice.
  const pendingOnce = useRef(false);

  const active = agreements.find((item) => item.id === activeId);

  useEffect(() => {
    setActiveFindingId(undefined);
    setDrafts({});
  }, [activeId]);

  if (!agreements.length || !active) {
    return (
      <section className="narrow-page"><div className="page-heading"><span className="eyebrow">Review queue</span><h1>Nothing is waiting</h1></div><div className="panel"><EmptyState title="The queue is clear" body="Add an agreement to begin testing." /><div className="center-action"><button className="primary-button" onClick={onNew}>New agreement</button></div></div></section>
    );
  }

  const shown = detail?.id === active.id ? detail : undefined;
  const findings = shown?.findings ?? [];
  const activeFinding = findings.find((finding) => finding.id === activeFindingId) ?? findings[0];
  const locked = !isOpen(active);
  const canReview = role !== "Requester" && !locked && !!shown;
  const pendingCount = findings.filter((finding) => finding.decision === "pending").length;

  const noteFor = (finding: FindingRecord) => drafts[finding.id] ?? finding.note;
  const clearDraft = (findingId: string) => setDrafts((current) => withoutKey(current, findingId));

  const decide = async (decision: FindingDecisionCode) => {
    if (!activeFinding) return;
    if (await onDecide(activeFinding.id, decision, noteFor(activeFinding))) clearDraft(activeFinding.id);
  };

  /** Saves the open finding's unsaved note, if any. Resolves false only when a save was needed and failed. */
  const saveNote = async (): Promise<boolean> => {
    if (!activeFinding || !canReview) return true;
    const draft = drafts[activeFinding.id];
    if (draft === undefined || draft === activeFinding.note) return true;
    if (!(await onDecide(activeFinding.id, activeFinding.decision, draft))) return false;
    clearDraft(activeFinding.id);
    return true;
  };

  const once = async (action: () => Promise<unknown>) => {
    if (pendingOnce.current) return;
    pendingOnce.current = true;
    try {
      await action();
    } finally {
      pendingOnce.current = false;
    }
  };

  const complete = () =>
    once(async () => {
      if (!shown || !(await saveNote())) return;
      await onComplete(shown.id);
    });

  const addManualFinding = async () => {
    if (!shown) return;
    const sourceText = shown.rawText.slice(0, 280).replace(/\s+/g, " ").trim() || "No source text available.";
    const before = new Set(shown.findings.map((finding) => finding.id));
    const updated = await onAddManual(shown.id, manualCategory, sourceText);
    const added = updated?.findings.find((finding) => !before.has(finding.id));
    if (added) setActiveFindingId(added.id);
  };

  return (
    <section>
      <div className="page-heading queue-heading">
        <div><span className="eyebrow">Human review</span><h1>Review queue</h1><p>Confirm each flag against its source before completing the review.</p></div>
        <button className="secondary-button" onClick={onNew}>＋ Add agreement</button>
      </div>

      {role === "Requester" && <div className="permission-banner">Requester view shows status and outcomes. Switch to Reviewer or Approver to record decisions.</div>}

      <div className="review-layout">
        <aside className="queue-list panel">
          <div className="queue-label">{agreements.length} agreements</div>
          {agreements.map((agreement) => (
            <button key={agreement.id} className={`queue-row ${agreement.id === active.id ? "selected" : ""}`} onClick={() => onSelect(agreement.id)}>
              <span className="file-tile small"><Icon name="file" /></span>
              <span><strong>{agreement.name}</strong><small>{agreement.vendor}<br />{agreement.findingCount} findings</small></span>
              <StatusPill status={agreement.status} />
            </button>
          ))}
        </aside>

        <div className="review-detail panel" aria-busy={busy || !shown}>
          <div className="document-heading">
            <div><span className="eyebrow">{active.vendor}</span><h2>{active.name}</h2><p>Submitted {formatDate(active.submittedAt)}{shown?.pageCount ? ` · ${shown.pageCount} pages` : ""}</p></div>
            <StatusPill status={active.status} />
          </div>

          {!shown ? (
            detailError ? <p className="error-message" role="alert">{detailError}</p> : <p>Loading agreement…</p>
          ) : (
            <>
              {!!shown.extractionWarnings.length && (
                <div className="permission-banner">
                  <strong>Extraction notes:</strong> {shown.extractionWarnings.join(" ")}
                </div>
              )}
              {!!shown.documents.length && (
                <p className="document-links">
                  Original file:{" "}
                  {shown.documents.map((document, index) => (
                    <span key={document.id}>
                      {index > 0 && ", "}
                      <a href={api.documentUrl(document.id)} download={document.fileName}>{document.fileName}</a>
                    </span>
                  ))}
                </p>
              )}

              <div className="review-body">
                <div className="finding-nav">
                  <div className="finding-nav-title"><strong>Findings</strong><span>{findings.length}</span></div>
                  {findings.map((finding) => (
                    <button key={finding.id} className={finding.id === activeFinding?.id ? "selected" : ""} onClick={() => setActiveFindingId(finding.id)}>
                      <span className={`decision-dot dot-${finding.decision}`} />
                      <span><strong>{finding.category}</strong><small>{Math.round(finding.confidence * 100)}% confidence</small></span>
                    </button>
                  ))}
                  {canReview && (
                    <div className="manual-add">
                      <select value={manualCategory} onChange={(event) => setManualCategory(event.target.value)}>{playbook.map((item) => <option key={item.name}>{item.name}</option>)}</select>
                      <button onClick={() => void once(addManualFinding)}>＋ Add manual finding</button>
                    </div>
                  )}
                </div>

                <div className="finding-detail">
                  {activeFinding ? (
                    <>
                      <div className="finding-title"><div><span className="eyebrow">{METHOD_LABELS[activeFinding.method]}</span><h3>{activeFinding.category}</h3></div><span className="confidence">{Math.round(activeFinding.confidence * 100)}% <small>confidence</small></span></div>
                      <div className="source-card"><span>Supporting source text</span><blockquote>{activeFinding.sourceText}</blockquote></div>
                      <label className="notes-field"><span>Reviewer note</span><textarea value={noteFor(activeFinding)} disabled={!canReview} onChange={(event) => setDrafts((current) => ({ ...current, [activeFinding.id]: event.target.value }))} onBlur={() => void saveNote()} placeholder="Record why you accepted, dismissed, or escalated this finding…" /></label>
                      {canReview && (
                        <div className="decision-actions">
                          <DecisionButton decision="accepted" current={activeFinding.decision} onClick={decide} label="Accept" />
                          <DecisionButton decision="dismissed" current={activeFinding.decision} onClick={decide} label="Dismiss" />
                          <DecisionButton decision="escalated" current={activeFinding.decision} onClick={decide} label="Escalate" />
                        </div>
                      )}
                    </>
                  ) : (
                    <EmptyState title="No rule-based findings" body="A reviewer can add a manual finding or complete the review with no flags." />
                  )}
                </div>
              </div>

              {canReview && (
                <div className="review-footer">
                  <p>{pendingCount} findings still need a decision</p>
                  <button className="primary-button" onClick={() => void complete()} disabled={pendingCount > 0}>Complete review</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function DecisionButton({
  decision,
  current,
  label,
  onClick,
}: {
  decision: FindingDecisionCode;
  current: FindingDecisionCode;
  label: string;
  onClick: (decision: FindingDecisionCode) => void;
}) {
  return <button className={`${current === decision ? "selected" : ""} decision-${decision}`} onClick={() => onClick(decision)}>{label}</button>;
}

type ReportState = { kind: "loading" } | { kind: "ready"; report: CategoryReport } | { kind: "error"; message: string };

function Reports() {
  const [state, setState] = useState<ReportState>({ kind: "loading" });

  useEffect(() => {
    let current = true;
    api.categoryReport().then(
      (report) => current && setState({ kind: "ready", report }),
      (reason) => current && setState({ kind: "error", message: errorMessage(reason, "Couldn't load the report.") }),
    );
    return () => {
      current = false;
    };
  }, []);

  const rows = state.kind === "ready" ? [...state.report.categories].sort((a, b) => b.total - a.total) : [];
  const max = Math.max(...rows.map((row) => row.total), 1);
  const count = state.kind === "ready" ? state.report.agreementCount : 0;

  return (
    <section className="narrow-page reports-page">
      <div className="page-heading"><span className="eyebrow">Prototype reporting</span><h1>Provision activity</h1><p>Counts come from the findings recorded in ClausePilot and update as reviews are completed.</p></div>
      <div className="panel report-panel">
        <div className="panel-heading"><div><h2>Findings by category</h2><p>{state.kind === "ready" ? `${count} agreement${count === 1 ? "" : "s"} visible to you` : " "}</p></div></div>
        {state.kind === "loading" && <p>Loading report…</p>}
        {state.kind === "error" && <p className="error-message" role="alert">{state.message}</p>}
        {state.kind === "ready" && (
          <div className="report-table">
            <div className="report-row report-header"><span>Category</span><span>Frequency</span><span>Total</span><span>Accepted</span><span>Escalated</span></div>
            {rows.map((row) => (
              <div className="report-row" key={row.category}>
                <strong>{row.category}</strong>
                <span className="bar-track"><i style={{ width: `${(row.total / max) * 100}%` }} /></span>
                <span>{row.total}</span><span>{row.accepted}</span><span>{row.escalated}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
