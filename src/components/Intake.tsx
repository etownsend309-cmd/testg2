import { useRef, useState } from "react";
import { Icon } from "./Icon";
import { demoAgreementText } from "../data";
import { extractText } from "../lib/extractText";
import { LIMITS, type NewAgreementInput } from "../shared/api";

type RequiredField = "document" | "vendor" | "agreementType" | "businessUnit" | "neededBy";
type Errors = Partial<Record<RequiredField, string>>;

/**
 * The submission form. Text is extracted here, in the browser; `onSubmit`
 * sends the details and the original file to the server and rejects with a
 * message for the person if the agreement was not saved.
 */
export function Intake({ onSubmit }: { onSubmit: (input: NewAgreementInput, file: File) => Promise<void> }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const inFlight = useRef(false);
  const [file, setFile] = useState<File>();
  const [title, setTitle] = useState("");
  const [vendor, setVendor] = useState("");
  const [agreementType, setAgreementType] = useState("");
  const [businessUnit, setBusinessUnit] = useState("");
  const [neededBy, setNeededBy] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [dragging, setDragging] = useState(false);

  const clearError = (field: RequiredField) => {
    setErrors((current) => ({ ...current, [field]: undefined }));
    setError("");
  };
  const chooseFile = (next?: File) => {
    if (!next || inFlight.current) return;
    setFile(next);
    if (!title.trim()) setTitle(next.name);
    clearError("document");
  };
  const errorFor = (field: RequiredField) => errors[field] && <span id={`${field}-error`} className="error-message">{errors[field]}</span>;
  const accessibility = (field: RequiredField) => ({
    id: field,
    "aria-invalid": Boolean(errors[field]),
    "aria-describedby": errors[field] ? `${field}-error` : undefined,
    "aria-required": true as const,
  });

  const submit = async () => {
    if (inFlight.current) return;
    const next: Errors = {};
    if (!file) next.document = "Choose a PDF or text document.";
    else if (file.size > LIMITS.documentBytes) next.document = "Choose a file of 25 MB or less.";
    if (!vendor.trim()) next.vendor = "Enter a vendor.";
    if (!agreementType.trim()) next.agreementType = "Enter an agreement type.";
    if (!businessUnit.trim()) next.businessUnit = "Enter a business unit.";
    if (!neededBy) next.neededBy = "Enter a needed-by date.";
    else {
      const parsed = new Date(`${neededBy}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(neededBy) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== neededBy) next.neededBy = "Enter a valid needed-by date.";
    }
    setErrors(next);
    setError("");
    const first = Object.keys(next)[0];
    if (first) {
      form.current?.querySelector<HTMLElement>(`#${first}`)?.focus();
      return;
    }
    inFlight.current = true;
    setIsLoading(true);
    try {
      const document = await extractText(file!);
      await onSubmit({
        name: title.trim() || file!.name,
        vendor: vendor.trim(), agreementType: agreementType.trim(), businessUnit: businessUnit.trim(), neededBy,
        rawText: document.text, pageCount: document.pageCount,
        extractionStrategy: document.strategy, extractionWarnings: document.warnings,
      }, file!);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Submission failed. Your agreement was not saved. Try again.");
    } finally {
      inFlight.current = false;
      setIsLoading(false);
    }
  };

  const loadDemo = () => {
    chooseFile(new File([demoAgreementText], "Northstar MSA.txt", { type: "text/plain" }));
    setTitle("Northstar MSA"); setVendor("Northstar Data");
    setAgreementType("Master services agreement"); setBusinessUnit("Shared services");
    const today = new Date();
    setNeededBy(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`);
    setErrors({});
  };

  return <section className="narrow-page">
    <div className="page-heading"><span className="eyebrow">Agreement intake</span><h1>Start a first-pass review</h1><p>Submit a PDF or TXT agreement with its review details. Fields marked * are required.</p></div>
    <div className="intake-layout">
      <form ref={form} className="panel intake-card" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }} aria-busy={isLoading}>
        <fieldset disabled={isLoading} className="intake-fields">
          <legend>Agreement submission</legend>
          <div className="step-heading"><span>1</span><div><h2>Agreement document *</h2><p>Text-based PDF or TXT, up to 25 MB.</p></div></div>
          <input ref={fileInput} className="visually-hidden" tabIndex={-1} type="file" aria-label="Agreement document" accept="application/pdf,.pdf,text/plain,.txt" onChange={(event) => { chooseFile(event.target.files?.[0]); event.target.value = ""; }} />
          <button type="button" {...accessibility("document")} aria-label={file ? `Replace agreement document: ${file.name}` : "Drop an agreement here, or click to browse"} className={`drop-zone ${file ? "has-file" : ""}${dragging ? " dragging" : ""}`} onClick={() => fileInput.current?.click()} onDragOver={(event) => { event.preventDefault(); if (!inFlight.current) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files?.[0]); }}>
            <span className="upload-mark"><Icon name="upload" /></span>
            {file ? <><strong>{file.name}</strong><small>{(file.size / 1024).toFixed(1)} KB · Click or drop to replace</small></> : <><strong>Drop an agreement here, or click to browse</strong><small>Text-based PDF or TXT</small></>}
          </button>
          {errorFor("document")}
          <div className="form-grid">
            <label htmlFor="title"><span>Agreement title (optional)</span><input id="title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g., Northstar MSA" /></label>
            <label htmlFor="vendor"><span>Vendor *</span><input {...accessibility("vendor")} required value={vendor} onChange={(event) => { setVendor(event.target.value); clearError("vendor"); }} placeholder="e.g., Northstar Data" />{errorFor("vendor")}</label>
            <label htmlFor="agreementType"><span>Agreement type *</span><input {...accessibility("agreementType")} required value={agreementType} onChange={(event) => { setAgreementType(event.target.value); clearError("agreementType"); }} placeholder="e.g., Master services agreement" />{errorFor("agreementType")}</label>
            <label htmlFor="businessUnit"><span>Business unit *</span><input {...accessibility("businessUnit")} required value={businessUnit} onChange={(event) => { setBusinessUnit(event.target.value); clearError("businessUnit"); }} placeholder="e.g., Shared services" />{errorFor("businessUnit")}</label>
            <label htmlFor="neededBy"><span>Needed-by date *</span><input {...accessibility("neededBy")} required type="date" value={neededBy} onChange={(event) => { setNeededBy(event.target.value); clearError("neededBy"); }} />{errorFor("neededBy")}</label>
          </div>
          <div role="alert">{Object.values(errors).some(Boolean) && <p className="error-message">Submission not completed. Correct the marked fields and try again.</p>}{error && <p className="error-message">{error}</p>}</div>
          <div className="form-actions"><button type="button" className="secondary-button" onClick={loadDemo}>Load demo agreement</button><button type="submit" className="primary-button">{isLoading ? "Submitting…" : "Create review →"}</button></div>
        </fieldset>
      </form>
      <aside className="intake-aside"><div className="aside-block"><div><strong>Saved to ClausePilot</strong><p>Text is extracted in your browser. The details, extracted text and original file are then stored in ClausePilot, where reviewers can see them. Don't submit real confidential agreements to this prototype.</p></div></div><div className="aside-block"><div><strong>Track your submission</strong><p>After submission, My submissions shows your reference number, details, and review status.</p></div></div></aside>
    </div>
  </section>;
}
