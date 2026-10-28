-- KAN-21A: row-level security.
--
-- How a request is scoped (see server/db.ts):
--
--   BEGIN;
--   SET LOCAL ROLE clausepilot_app;                       -- no BYPASSRLS, not the owner
--   SELECT set_config('app.user_id', '<app_users.id>', true);
--   ... queries ...
--   COMMIT;
--
-- `clausepilot_app` is subject to every policy below. The migration owner
-- (who runs migrations and seeds) owns the tables and so bypasses them, which
-- is why application code never queries as the owner.
--
-- Policy helpers are SECURITY DEFINER so that checking a role does not itself
-- pass through the policies on user_roles, which would recurse. They all fail
-- closed: with no `app.user_id`, or for a deactivated account, they return
-- false.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clausepilot_app') THEN
    CREATE ROLE clausepilot_app NOLOGIN NOBYPASSRLS;
  END IF;
  -- The migration owner must be able to SET ROLE to it at request time.
  EXECUTE format('GRANT clausepilot_app TO %I', current_user);
END;
$$;

CREATE SCHEMA app;

CREATE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE FUNCTION app.is_active_user() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM app_users WHERE id = app.current_user_id() AND is_active)
$$;

CREATE FUNCTION app.has_role(wanted app_role) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles r JOIN app_users u ON u.id = r.user_id
    WHERE r.user_id = app.current_user_id() AND r.role = wanted AND u.is_active
  )
$$;

CREATE FUNCTION app.is_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT app.has_role('administrator') $$;

CREATE FUNCTION app.can_review() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT app.has_role('reviewer') OR app.has_role('administrator') $$;

CREATE FUNCTION app.can_approve() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app.can_review() AND EXISTS (
    SELECT 1 FROM user_permissions
    WHERE user_id = app.current_user_id() AND permission = 'approve'
  )
$$;

CREATE FUNCTION app.can_see_agreement(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app.is_active_user() AND (
    app.can_review() OR EXISTS (
      SELECT 1 FROM agreements WHERE id = target AND submitted_by = app.current_user_id()
    )
  )
$$;

-- True only for the submitter, while nobody has started reviewing. This is
-- the window in which a requester attaches the document and the local-rule
-- findings to their own submission.
CREATE FUNCTION app.is_own_new_agreement(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app.is_active_user() AND EXISTS (
    SELECT 1 FROM agreements
    WHERE id = target AND submitted_by = app.current_user_id() AND status = 'needs_review'
  )
$$;

-- Session bootstrap. Called before the caller has an app.user_id, so it
-- cannot go through the policies. It finds the account for a verified
-- Netlify Identity user: by identity_id, else by claiming a pre-provisioned
-- row with the same email, else by creating a Requester. Returns NULL for a
-- deactivated account. `make_admin` is decided by trusted server
-- configuration (BOOTSTRAP_ADMIN_EMAILS), never by the browser.
CREATE FUNCTION app.resolve_session(
  p_identity_id text,
  p_email text,
  p_display_name text,
  make_admin boolean DEFAULT false
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  normalized text := lower(btrim(p_email));
  account app_users%ROWTYPE;
BEGIN
  IF coalesce(btrim(p_identity_id), '') = '' OR normalized = '' THEN
    RAISE EXCEPTION 'A verified identity id and email are required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO account FROM app_users WHERE identity_id = p_identity_id FOR UPDATE;

  IF NOT FOUND THEN
    SELECT * INTO account FROM app_users WHERE email = normalized AND identity_id IS NULL FOR UPDATE;
    IF FOUND THEN
      UPDATE app_users SET identity_id = p_identity_id WHERE id = account.id;
    ELSE
      INSERT INTO app_users (identity_id, email, display_name)
      VALUES (p_identity_id, normalized, coalesce(btrim(p_display_name), ''))
      RETURNING * INTO account;
      INSERT INTO user_roles (user_id, role) VALUES (account.id, 'requester');
    END IF;
  END IF;

  IF NOT account.is_active THEN
    RETURN NULL;
  END IF;

  IF make_admin THEN
    INSERT INTO user_roles (user_id, role) VALUES (account.id, 'administrator')
    ON CONFLICT DO NOTHING;
  END IF;

  UPDATE app_users
  SET last_seen_at = now(),
      email = normalized,
      display_name = CASE WHEN display_name = '' THEN coalesce(btrim(p_display_name), '') ELSE display_name END
  WHERE id = account.id;

  RETURN account.id;
END;
$$;

-- Workflow rules that policies cannot express column by column.
CREATE FUNCTION enforce_agreement_workflow() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor uuid := app.current_user_id();
BEGIN
  IF actor IS NULL THEN
    RETURN NEW;  -- migrations and seeds, running as the owner
  END IF;

  IF NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'The submitter of an agreement cannot be changed.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF (NEW.status = 'approved') IS DISTINCT FROM (OLD.status = 'approved') THEN
    IF NOT app.can_approve() THEN
      RAISE EXCEPTION 'Approving an agreement requires the Approver permission.' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  IF NEW.status = 'approved' AND OLD.status <> 'approved' THEN
    NEW.approved_by := actor;
    NEW.approved_at := now();
  ELSIF NEW.status <> 'approved' THEN
    NEW.approved_by := NULL;
    NEW.approved_at := NULL;
  ELSE
    NEW.approved_by := OLD.approved_by;
    NEW.approved_at := OLD.approved_at;
  END IF;

  IF NEW.status IN ('approved', 'escalated') AND OLD.status NOT IN ('approved', 'escalated') THEN
    NEW.completed_at := now();
  ELSIF NEW.status NOT IN ('approved', 'escalated') THEN
    NEW.completed_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER agreements_enforce_workflow
  BEFORE UPDATE ON agreements
  FOR EACH ROW EXECUTE FUNCTION enforce_agreement_workflow();

CREATE FUNCTION stamp_finding_decision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app.current_user_id() IS NOT NULL THEN
    IF TG_OP = 'INSERT' THEN
      NEW.created_by := app.current_user_id();
    END IF;
    IF NEW.decision IS DISTINCT FROM (CASE WHEN TG_OP = 'INSERT' THEN 'pending'::finding_decision ELSE OLD.decision END)
       OR (TG_OP = 'UPDATE' AND NEW.note IS DISTINCT FROM OLD.note) THEN
      NEW.decided_by := app.current_user_id();
      NEW.decided_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER findings_stamp_decision
  BEFORE INSERT OR UPDATE ON findings
  FOR EACH ROW EXECUTE FUNCTION stamp_finding_decision();

-- Policies -------------------------------------------------------------------

ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE agreement_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

-- People: you can see yourself; reviewers see everyone (names on findings and
-- assignments); only administrators change accounts.
CREATE POLICY app_users_select ON app_users FOR SELECT
  USING (app.is_active_user() AND (id = app.current_user_id() OR app.can_review()));
CREATE POLICY app_users_insert ON app_users FOR INSERT WITH CHECK (app.is_admin());
CREATE POLICY app_users_update ON app_users FOR UPDATE USING (app.is_admin()) WITH CHECK (app.is_admin());

CREATE POLICY user_roles_select ON user_roles FOR SELECT
  USING (app.is_active_user() AND (user_id = app.current_user_id() OR app.is_admin()));
CREATE POLICY user_roles_insert ON user_roles FOR INSERT WITH CHECK (app.is_admin());
CREATE POLICY user_roles_delete ON user_roles FOR DELETE USING (app.is_admin());

CREATE POLICY user_permissions_select ON user_permissions FOR SELECT
  USING (app.is_active_user() AND (user_id = app.current_user_id() OR app.is_admin()));
CREATE POLICY user_permissions_insert ON user_permissions FOR INSERT WITH CHECK (app.is_admin());
CREATE POLICY user_permissions_delete ON user_permissions FOR DELETE USING (app.is_admin());

-- Agreements: requesters see their own; reviewers, approvers and
-- administrators see all. Requesters and administrators submit; reviewers
-- change; only administrators delete.
CREATE POLICY agreements_select ON agreements FOR SELECT
  USING (app.is_active_user() AND (submitted_by = app.current_user_id() OR app.can_review()));
CREATE POLICY agreements_insert ON agreements FOR INSERT
  WITH CHECK (
    submitted_by = app.current_user_id()
    AND (app.has_role('requester') OR app.is_admin())
    AND status = 'needs_review'
    AND approved_by IS NULL
    AND completed_at IS NULL
  );
CREATE POLICY agreements_update ON agreements FOR UPDATE
  USING (app.can_review()) WITH CHECK (app.can_review());
CREATE POLICY agreements_delete ON agreements FOR DELETE USING (app.is_admin());

CREATE POLICY findings_select ON findings FOR SELECT USING (app.can_see_agreement(agreement_id));
CREATE POLICY findings_insert ON findings FOR INSERT
  WITH CHECK (
    app.can_review()
    OR (app.is_own_new_agreement(agreement_id) AND method = 'local_rule' AND decision = 'pending')
  );
CREATE POLICY findings_update ON findings FOR UPDATE USING (app.can_review()) WITH CHECK (app.can_review());
CREATE POLICY findings_delete ON findings FOR DELETE USING (app.is_admin());

CREATE POLICY agreement_documents_select ON agreement_documents FOR SELECT
  USING (app.can_see_agreement(agreement_id));
CREATE POLICY agreement_documents_insert ON agreement_documents FOR INSERT
  WITH CHECK (
    uploaded_by = app.current_user_id()
    AND (app.can_review() OR app.is_own_new_agreement(agreement_id))
  );
CREATE POLICY agreement_documents_delete ON agreement_documents FOR DELETE USING (app.is_admin());

-- The audit trail is append-only for everyone, administrators included.
CREATE POLICY audit_events_select ON audit_events FOR SELECT
  USING (app.is_admin() OR (agreement_id IS NOT NULL AND app.can_see_agreement(agreement_id)));
CREATE POLICY audit_events_insert ON audit_events FOR INSERT
  WITH CHECK (actor_id = app.current_user_id() AND app.is_active_user());

-- Grants ---------------------------------------------------------------------

REVOKE ALL ON SCHEMA app FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;

GRANT USAGE ON SCHEMA public, app TO clausepilot_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO clausepilot_app;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON app_users, user_roles, user_permissions, agreements, findings, agreement_documents
  TO clausepilot_app;
GRANT SELECT, INSERT ON audit_events TO clausepilot_app;
