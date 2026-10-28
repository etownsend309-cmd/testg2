-- KAN-21A: the review workflow — agreements, findings, uploaded documents and
-- an audit trail.
--
-- Document bytes are not stored here. They live in a private Netlify Blobs
-- store under `blob_key`, and this table is the authority on who may read
-- them: the download function only serves a key it found through a query
-- that row-level security has already filtered.

CREATE TYPE agreement_status AS ENUM ('needs_review', 'in_review', 'approved', 'escalated');
CREATE TYPE finding_decision AS ENUM ('pending', 'accepted', 'dismissed', 'escalated');
CREATE TYPE finding_method AS ENUM ('local_rule', 'manual');

CREATE TABLE agreements (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL CHECK (btrim(name) <> ''),
  vendor               text NOT NULL CHECK (btrim(vendor) <> ''),
  agreement_type       text NOT NULL,
  business_unit        text NOT NULL,
  needed_by            date,
  submitted_by         uuid NOT NULL REFERENCES app_users (id),
  submitted_at         timestamptz NOT NULL DEFAULT now(),
  status               agreement_status NOT NULL DEFAULT 'needs_review',
  raw_text             text NOT NULL DEFAULT '',
  page_count           integer CHECK (page_count IS NULL OR page_count > 0),
  extraction_strategy  text,
  extraction_warnings  text[] NOT NULL DEFAULT '{}',
  completed_at         timestamptz,
  approved_by          uuid REFERENCES app_users (id),
  approved_at          timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE INDEX agreements_submitted_by_idx ON agreements (submitted_by);
CREATE INDEX agreements_status_idx ON agreements (status);

-- The 12 approved CUAD playbook categories (see src/lib/analyze.ts).
-- Indemnification is deliberately not one of them.
CREATE TABLE findings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id  uuid NOT NULL REFERENCES agreements (id) ON DELETE CASCADE,
  category      text NOT NULL CHECK (category IN (
                  'Governing Law', 'Anti-Assignment', 'Cap On Liability', 'Audit Rights',
                  'Termination For Convenience', 'Exclusivity', 'Renewal Term', 'Insurance',
                  'Change Of Control', 'Uncapped Liability', 'Notice Period To Terminate Renewal',
                  'Warranty Duration')),
  confidence    numeric(4, 3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source_text   text NOT NULL DEFAULT '',
  decision      finding_decision NOT NULL DEFAULT 'pending',
  note          text NOT NULL DEFAULT '',
  method        finding_method NOT NULL,
  created_by    uuid REFERENCES app_users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid REFERENCES app_users (id),
  decided_at    timestamptz
);

CREATE INDEX findings_agreement_id_idx ON findings (agreement_id);

CREATE TABLE agreement_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id  uuid NOT NULL REFERENCES agreements (id) ON DELETE CASCADE,
  blob_key      text NOT NULL UNIQUE,
  file_name     text NOT NULL CHECK (btrim(file_name) <> ''),
  content_type  text NOT NULL CHECK (content_type IN ('application/pdf', 'text/plain')),
  byte_size     bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 26214400),
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by   uuid NOT NULL REFERENCES app_users (id),
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agreement_documents_agreement_id_idx ON agreement_documents (agreement_id);

CREATE TABLE audit_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id      uuid REFERENCES app_users (id),
  agreement_id  uuid REFERENCES agreements (id) ON DELETE SET NULL,
  action        text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_agreement_id_idx ON audit_events (agreement_id);

CREATE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER agreements_touch_updated_at
  BEFORE UPDATE ON agreements
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
