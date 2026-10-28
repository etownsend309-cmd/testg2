-- Remove every ClausePilot account except two, as requested on 2026-10-28:
--   etownsend309@gmail.com
--   ejt41483@uga.edu
--
-- Their roles and permissions go with them (ON DELETE CASCADE). Records that
-- only mention a removed person as the actor (audit events, who granted a role,
-- who created or decided a finding) are kept with that reference cleared.
--
-- Agreements are different: an agreement must have a submitter, an approved
-- agreement must have an approver, and a document must have an uploader. If a
-- removed person is any of those, this migration stops with an error instead
-- of deleting agreements nobody asked to delete. The deploy then fails and the
-- site stays as it was.
--
-- This removes ClausePilot accounts only. Sign-ins live in Netlify Identity:
-- anyone still listed there who signs in again gets a new Requester account.

-- Plain SQL with no temporary table, so it behaves the same whether or not
-- the migration runner wraps it in a transaction.
DO $$
DECLARE
  blocking text;
BEGIN
  SELECT string_agg(DISTINCT u.email, ', ' ORDER BY u.email) INTO blocking
    FROM app_users u
   WHERE lower(u.email) NOT IN ('etownsend309@gmail.com', 'ejt41483@uga.edu')
     AND (EXISTS (SELECT 1 FROM agreements a WHERE a.submitted_by = u.id OR a.approved_by = u.id)
          OR EXISTS (SELECT 1 FROM agreement_documents d WHERE d.uploaded_by = u.id));
  IF blocking IS NOT NULL THEN
    RAISE EXCEPTION 'Not removing accounts: these people submitted, approved or uploaded files for existing agreements: %. Delete or reassign those agreements first.', blocking;
  END IF;

  UPDATE findings SET created_by = NULL
   WHERE created_by IN (SELECT id FROM app_users WHERE lower(email) NOT IN ('etownsend309@gmail.com', 'ejt41483@uga.edu'));
  UPDATE findings SET decided_by = NULL
   WHERE decided_by IN (SELECT id FROM app_users WHERE lower(email) NOT IN ('etownsend309@gmail.com', 'ejt41483@uga.edu'));
  UPDATE audit_events SET actor_id = NULL
   WHERE actor_id IN (SELECT id FROM app_users WHERE lower(email) NOT IN ('etownsend309@gmail.com', 'ejt41483@uga.edu'));

  DELETE FROM app_users WHERE lower(email) NOT IN ('etownsend309@gmail.com', 'ejt41483@uga.edu');
END;
$$;
