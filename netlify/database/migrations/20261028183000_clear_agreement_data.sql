-- Clean start: remove every agreement, as requested on 2026-10-28.
--
-- Deletes all agreements, including the four demo agreements from
-- 20261027230300_seed_demo_data.sql and anything submitted since. Their
-- findings and document records go with them (ON DELETE CASCADE), and so does
-- their audit history. User accounts, roles, permissions, and audit events
-- about account access are kept, so everyone signs in with the same access.
--
-- Uploaded files are stored in Netlify Blobs, which a migration cannot reach.
-- Once their document rows are gone nothing can serve them, because the API
-- only downloads a file it finds through an agreement_documents row.
--
-- Runs as the migration owner, so row-level security and the append-only
-- audit policy do not apply here.

DELETE FROM audit_events
 WHERE agreement_id IS NOT NULL
    OR action LIKE 'agreement.%'
    OR action LIKE 'finding.%'
    OR action LIKE 'document.%';

DELETE FROM agreements;
