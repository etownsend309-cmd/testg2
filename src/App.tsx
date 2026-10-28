import { useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@netlify/identity";
import { Icon } from "./components/Icon";
import { Intake } from "./components/Intake";
import { playbook } from "./lib/analyze";
import type {
  Agreement,
  Finding,
  FindingDecision,
  Role,
  View,
} from "./types";

const STORAGE_KEY = "clausepilot-agreements-v1";

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

function StatusPill({ status }: { status: Agreement["status"] }) {
  return <span className={`status status-${status.toLowerCase().replaceAll(" ", "-")}`}>{status}</span>;
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

interface AppProps {
  // Only the identity is read here, so the prop is narrowed to it. A full
  // Netlify `User` still satisfies this, and tests do not have to build one.
  user: Pick<User, "id" | "email">;
  /** The workspace views this person's roles allow, from the API session (see availableViews). */
  views: Role[];
  displayName?: string;
  onSignOut: () => void;
}

export default function App({ user, views, displayName, onSignOut }: AppProps) {
  const requesterId = user.email ?? user.id;
  const [view, setView] = useState<View>("overview");
  // Start in the most review-oriented view the person holds, as the app
  // always has; the switcher only ever offers views they are entitled to.
  const [chosenRole, setRole] = useState<Role | undefined>(undefined);
  const role: Role =
    chosenRole && views.includes(chosenRole) ? chosenRole : (views.find((v) => v === "Reviewer") ?? views[0] ?? "Requester");
  const [agreements, setAgreements] = useState<Agreement[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
      if (!Array.isArray(saved)) return [];
      return saved.map((agreement) => ({
        ...agreement,
        agreementType: agreement.agreementType ?? "",
        businessUnit: agreement.businessUnit ?? "",
        neededBy: agreement.neededBy ?? "",
      })) as Agreement[];
    } catch {
      return [];
    }
  });
  const [activeAgreementId, setActiveAgreementId] = useState<string>();

  const [notice, setNotice] = useState("");
  const [saveError, setSaveError] = useState("");

  /**
   * The agreements as last written to storage.
   *
   * Extraction is awaited while the sidebar stays usable, so a reviewer can
   * record a decision between a submission starting and finishing. Callers must
   * build their next list from this rather than from `agreements`, which is
   * fixed at the render that created the callback. A functional `setAgreements`
   * updater would read the latest state but cannot replace this: the write has
   * to happen before the state change so a rejected write can throw, and an
   * updater must stay pure.
   */
  const agreementsRef = useRef(agreements);

  /**
   * Whether this session still owns the stored list.
   *
   * Signing out unmounts App, but an extraction already awaited keeps running
   * and still holds this instance's `onAdd` and `agreementsRef`. Storage is not
   * keyed by user, so a write landing after unmount would overwrite whatever
   * the next session has saved since, and that session would keep showing the
   * lost agreement until a reload. Set on mount, not just initialised, because
   * StrictMode runs the cleanup once before the real mount.
   */
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const persist = (next: Agreement[]) => {
    if (!live.current) {
      throw new Error("You were signed out before this submission finished, so it was not saved. Sign in and submit it again.");
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      throw new Error("The agreement could not be saved in this browser. Free storage space or enable site storage, then try again. Your submission was not saved.");
    }
    agreementsRef.current = next;
    setAgreements(next);
  };

  const activeAgreement =
    agreements.find((agreement) => agreement.id === activeAgreementId) ?? agreements[0];

  const openReview = (id: string) => {
    setActiveAgreementId(id);
    setView("review");
  };

  const addAgreement = (agreement: Agreement) => {
    persist([agreement, ...agreementsRef.current]);
    setNotice(`Agreement "${agreement.name}" submitted successfully. Reference: ${agreement.id}. Status: Needs review.`);
    setView("tracker");
  };

  const updateAgreement = (updated: Agreement) => {
    try {
      persist(agreementsRef.current.map((agreement) => agreement.id === updated.id ? updated : agreement));
      setSaveError("");
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : "The review could not be saved.");
    }
  };

  const startIntake = () => {
    setNotice("");
    setSaveError("");
    setView("intake");
  };

  const pending = agreements.filter((agreement) =>
    ["Needs review", "In review"].includes(agreement.status),
  ).length;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setView("overview")}>
          <span className="brand-mark"><Icon name="shield" /></span>
          <span>Clause<span>Pilot</span></span>
        </button>
        <nav aria-label="Primary navigation">
          <NavButton active={view === "overview"} icon="home" label="Overview" onClick={() => setView("overview")} />
          <NavButton active={view === "intake"} icon="upload" label="New agreement" onClick={() => startIntake()} />
          <NavButton active={view === "tracker"} icon="file" label="My submissions" onClick={() => setView("tracker")} />
          <NavButton active={view === "review"} icon="review" label="Review queue" count={pending} onClick={() => setView("review")} />
          <NavButton active={view === "reports"} icon="reports" label="Reports" onClick={() => setView("reports")} />
        </nav>
        <div className="sidebar-note">
          <span className="eyebrow">Prototype mode</span>
          <p>Data stays in this browser. No contract is sent to an AI service.</p>
          <a href="?view=extraction-poc">Extraction test harness →</a>
        </div>
        <div className="sidebar-note sidebar-account">
          <span className="eyebrow">Signed in</span>
          {displayName && <p className="account-name">{displayName}</p>}
          <p>{requesterId}</p>
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
          {view === "tracker" && <RequesterTracker agreements={agreements.filter((item) => item.submittedBy === requesterId)} />}
          {view === "overview" && (
            <Overview agreements={agreements} onNew={() => startIntake()} onReview={openReview} />
          )}
          {view === "intake" && <Intake submittedBy={requesterId} onAdd={addAgreement} />}
          {view === "review" && (
            <ReviewQueue
              agreements={agreements}
              active={activeAgreement}
              role={role}
              onSelect={setActiveAgreementId}
              onUpdate={updateAgreement}
              onNew={() => startIntake()}
            />
          )}
          {view === "reports" && <Reports agreements={agreements} />}
        </div>
      </main>
    </div>
  );
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
  agreements: Agreement[];
  onNew: () => void;
  onReview: (id: string) => void;
}) {
  const open = agreements.filter((item) => ["Needs review", "In review"].includes(item.status));
  const approved = agreements.filter((item) => item.status === "Approved").length;
  const escalated = agreements.filter((item) => item.status === "Escalated").length;

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
        <Metric label="Total agreements" value={agreements.length} note="Stored locally" tone="navy" />
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
                  <span className="finding-count">{agreement.findings.length} findings</span>
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

function RequesterTracker({ agreements }: { agreements: Agreement[] }) {
  return <section>
    <div className="page-heading"><span className="eyebrow">Requester tracker</span><h1>My submissions</h1><p>Track agreements submitted by the demo requester in this browser.</p></div>
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
  active,
  role,
  onSelect,
  onUpdate,
  onNew,
}: {
  agreements: Agreement[];
  active?: Agreement;
  role: Role;
  onSelect: (id: string) => void;
  onUpdate: (agreement: Agreement) => void;
  onNew: () => void;
}) {
  const canReview = role !== "Requester";
  const [activeFindingId, setActiveFindingId] = useState<string>();
  const [manualCategory, setManualCategory] = useState(playbook[0].name);

  useEffect(() => {
    setActiveFindingId(active?.findings[0]?.id);
    // Reset selection only when switching agreements, not when editing a finding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  if (!agreements.length || !active) {
    return (
      <section className="narrow-page"><div className="page-heading"><span className="eyebrow">Review queue</span><h1>Nothing is waiting</h1></div><div className="panel"><EmptyState title="The queue is clear" body="Add an agreement to begin testing." /><div className="center-action"><button className="primary-button" onClick={onNew}>New agreement</button></div></div></section>
    );
  }

  const activeFinding =
    active.findings.find((finding) => finding.id === activeFindingId) ?? active.findings[0];

  const updateFinding = (patch: Partial<Finding>) => {
    if (!activeFinding) return;
    onUpdate({
      ...active,
      status: active.status === "Needs review" ? "In review" : active.status,
      findings: active.findings.map((finding) =>
        finding.id === activeFinding.id ? { ...finding, ...patch } : finding,
      ),
    });
  };

  const addManualFinding = () => {
    const finding: Finding = {
      id: crypto.randomUUID(),
      category: manualCategory,
      confidence: 1,
      sourceText: active.rawText.slice(0, 280).replace(/\s+/g, " ") || "No source text available.",
      decision: "pending",
      note: "Added manually by reviewer.",
      method: "Manual",
    };
    onUpdate({ ...active, status: "In review", findings: [...active.findings, finding] });
    setActiveFindingId(finding.id);
  };

  const completeReview = () => {
    const hasPending = active.findings.some((finding) => finding.decision === "pending");
    if (hasPending) return;
    const hasEscalation = active.findings.some((finding) => finding.decision === "escalated");
    onUpdate({
      ...active,
      status: hasEscalation ? "Escalated" : "Approved",
      completedAt: new Date().toISOString(),
    });
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
              <span><strong>{agreement.name}</strong><small>{agreement.vendor}<br />{agreement.findings.length} findings</small></span>
              <StatusPill status={agreement.status} />
            </button>
          ))}
        </aside>

        <div className="review-detail panel">
          <div className="document-heading">
            <div><span className="eyebrow">{active.vendor}</span><h2>{active.name}</h2><p>Submitted {formatDate(active.submittedAt)}{active.pageCount ? ` · ${active.pageCount} pages` : ""}</p></div>
            <StatusPill status={active.status} />
          </div>

          {!!active.extractionWarnings?.length && (
            <div className="permission-banner">
              <strong>Extraction notes:</strong> {active.extractionWarnings.join(" ")}
            </div>
          )}

          <div className="review-body">
            <div className="finding-nav">
              <div className="finding-nav-title"><strong>Findings</strong><span>{active.findings.length}</span></div>
              {active.findings.map((finding) => (
                <button key={finding.id} className={finding.id === activeFinding?.id ? "selected" : ""} onClick={() => setActiveFindingId(finding.id)}>
                  <span className={`decision-dot dot-${finding.decision}`} />
                  <span><strong>{finding.category}</strong><small>{Math.round(finding.confidence * 100)}% confidence</small></span>
                </button>
              ))}
              {canReview && (
                <div className="manual-add">
                  <select value={manualCategory} onChange={(event) => setManualCategory(event.target.value)}>{playbook.map((item) => <option key={item.name}>{item.name}</option>)}</select>
                  <button onClick={addManualFinding}>＋ Add manual finding</button>
                </div>
              )}
            </div>

            <div className="finding-detail">
              {activeFinding ? (
                <>
                  <div className="finding-title"><div><span className="eyebrow">{activeFinding.method}</span><h3>{activeFinding.category}</h3></div><span className="confidence">{Math.round(activeFinding.confidence * 100)}% <small>confidence</small></span></div>
                  <div className="source-card"><span>Supporting source text</span><blockquote>{activeFinding.sourceText}</blockquote></div>
                  <label className="notes-field"><span>Reviewer note</span><textarea value={activeFinding.note} disabled={!canReview} onChange={(event) => updateFinding({ note: event.target.value })} placeholder="Record why you accepted, dismissed, or escalated this finding…" /></label>
                  {canReview && (
                    <div className="decision-actions">
                      <DecisionButton decision="accepted" current={activeFinding.decision} onClick={updateFinding} label="Accept" />
                      <DecisionButton decision="dismissed" current={activeFinding.decision} onClick={updateFinding} label="Dismiss" />
                      <DecisionButton decision="escalated" current={activeFinding.decision} onClick={updateFinding} label="Escalate" />
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
              <p>{active.findings.filter((finding) => finding.decision === "pending").length} findings still need a decision</p>
              <button className="primary-button" onClick={completeReview} disabled={active.findings.some((finding) => finding.decision === "pending")}>Complete review</button>
            </div>
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
  decision: FindingDecision;
  current: FindingDecision;
  label: string;
  onClick: (patch: Partial<Finding>) => void;
}) {
  return <button className={`${current === decision ? "selected" : ""} decision-${decision}`} onClick={() => onClick({ decision })}>{label}</button>;
}

function Reports({ agreements }: { agreements: Agreement[] }) {
  const rows = useMemo(
    () =>
      playbook
        .map((category) => {
          const findings = agreements.flatMap((agreement) => agreement.findings).filter((finding) => finding.category === category.name);
          return {
            category: category.name,
            total: findings.length,
            accepted: findings.filter((finding) => finding.decision === "accepted").length,
            escalated: findings.filter((finding) => finding.decision === "escalated").length,
          };
        })
        .sort((a, b) => b.total - a.total),
    [agreements],
  );
  const max = Math.max(...rows.map((row) => row.total), 1);

  return (
    <section className="narrow-page reports-page">
      <div className="page-heading"><span className="eyebrow">Prototype reporting</span><h1>Provision activity</h1><p>Counts are derived from the local flag table and update as reviews are completed.</p></div>
      <div className="panel report-panel">
        <div className="panel-heading"><div><h2>Findings by category</h2><p>{agreements.length} agreement{agreements.length === 1 ? "" : "s"} in this browser</p></div></div>
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
      </div>
    </section>
  );
}
