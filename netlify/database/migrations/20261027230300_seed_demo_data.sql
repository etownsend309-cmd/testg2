-- KAN-21A: representative accounts and demonstration data.
--
-- The four accounts are pre-provisioned: they have no identity_id yet. Each is
-- claimed on first sign-in by a Netlify Identity user with the same email
-- (app.resolve_session). Identity is invite-only, so nobody can claim one
-- without being invited to that address first. To demo the roles, invite
-- these addresses from the Netlify Identity dashboard, or change the emails
-- here in a later migration to addresses your team controls.
--
-- Fixed ids keep the data stable across environments and easy to reference
-- in tests. All agreement content is fictional.

INSERT INTO app_users (id, email, display_name) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'requester@example.test', 'Riley Requester'),
  ('a0000000-0000-4000-8000-000000000002', 'reviewer@example.test',  'Rowan Reviewer'),
  ('a0000000-0000-4000-8000-000000000003', 'approver@example.test',  'Avery Approver'),
  ('a0000000-0000-4000-8000-000000000004', 'admin@example.test',     'Alex Administrator');

INSERT INTO user_roles (user_id, role) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'requester'),
  ('a0000000-0000-4000-8000-000000000002', 'reviewer'),
  ('a0000000-0000-4000-8000-000000000003', 'reviewer'),
  ('a0000000-0000-4000-8000-000000000004', 'administrator');

-- Approver is the extra permission on top of a reviewing role.
INSERT INTO user_permissions (user_id, permission) VALUES
  ('a0000000-0000-4000-8000-000000000003', 'approve');

INSERT INTO agreements (
  id, name, vendor, agreement_type, business_unit, needed_by,
  submitted_by, submitted_at, status, raw_text, page_count,
  completed_at, approved_by, approved_at
) VALUES
  ('b0000000-0000-4000-8000-000000000001',
   'Northstar Data MSA', 'Northstar Data, Inc.', 'Master Services Agreement', 'Finance',
   '2026-11-20', 'a0000000-0000-4000-8000-000000000001', '2026-10-20 14:05:00+00', 'needs_review',
   'MASTER SERVICES AGREEMENT between Calder Industries and Northstar Data, Inc. '
   '22. GOVERNING LAW. This Agreement is governed by the laws of the State of Georgia. '
   '15. ASSIGNMENT. Vendor may not assign this Agreement without Customer''s prior written consent. '
   '9. LIMITATION OF LIABILITY. Each party''s aggregate liability shall not exceed the fees paid during the twelve months preceding the claim.',
   4, NULL, NULL, NULL),
  ('b0000000-0000-4000-8000-000000000002',
   'Harbor Logistics Services Agreement', 'Harbor Logistics LLC', 'Services Agreement', 'Operations',
   '2026-11-05', 'a0000000-0000-4000-8000-000000000001', '2026-10-14 09:30:00+00', 'in_review',
   'SERVICES AGREEMENT. 11. TERM AND RENEWAL. This Agreement will automatically renew for successive one-year terms '
   'unless either party gives at least sixty days'' written notice. 16. AUDIT RIGHTS. Customer has the right to audit '
   'Vendor''s books and records once per year.',
   3, NULL, NULL, NULL),
  ('b0000000-0000-4000-8000-000000000003',
   'Bluefin Software License', 'Bluefin Software Co.', 'Software License', 'IT',
   '2026-10-30', 'a0000000-0000-4000-8000-000000000001', '2026-10-02 16:45:00+00', 'approved',
   'SOFTWARE LICENSE AGREEMENT. 18. INSURANCE. Vendor will maintain commercial general liability insurance. '
   '19. WARRANTY DURATION. The warranty period will continue for twelve months after delivery.',
   2, '2026-10-09 11:00:00+00', 'a0000000-0000-4000-8000-000000000003', '2026-10-09 11:00:00+00'),
  ('b0000000-0000-4000-8000-000000000004',
   'Summit Staffing Exclusive Supply', 'Summit Staffing Group', 'Supply Agreement', 'People',
   '2026-11-12', 'a0000000-0000-4000-8000-000000000004', '2026-10-06 13:15:00+00', 'escalated',
   'SUPPLY AGREEMENT. 17. EXCLUSIVITY. Vendor will serve as Customer''s exclusive provider for the covered services. '
   '8. INDEMNIFICATION. Vendor''s indemnification obligations are not subject to the liability cap. '
   'A change of control will be treated as an assignment.',
   5, '2026-10-12 15:20:00+00', NULL, NULL);

INSERT INTO findings (
  agreement_id, category, confidence, source_text, decision, note, method,
  created_by, decided_by, decided_at
) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'Governing Law', 0.98,
   'This Agreement is governed by the laws of the State of Georgia.', 'pending', '', 'local_rule',
   'a0000000-0000-4000-8000-000000000001', NULL, NULL),
  ('b0000000-0000-4000-8000-000000000001', 'Anti-Assignment', 0.93,
   'Vendor may not assign this Agreement without Customer''s prior written consent.', 'pending', '', 'local_rule',
   'a0000000-0000-4000-8000-000000000001', NULL, NULL),
  ('b0000000-0000-4000-8000-000000000001', 'Cap On Liability', 0.96,
   'Each party''s aggregate liability shall not exceed the fees paid during the twelve months preceding the claim.',
   'pending', '', 'local_rule', 'a0000000-0000-4000-8000-000000000001', NULL, NULL),

  ('b0000000-0000-4000-8000-000000000002', 'Renewal Term', 0.91,
   'This Agreement will automatically renew for successive one-year terms', 'accepted', 'Standard renewal.', 'local_rule',
   'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', '2026-10-16 10:00:00+00'),
  ('b0000000-0000-4000-8000-000000000002', 'Notice Period To Terminate Renewal', 0.9,
   'unless either party gives at least sixty days'' written notice', 'pending', '', 'local_rule',
   'a0000000-0000-4000-8000-000000000001', NULL, NULL),
  ('b0000000-0000-4000-8000-000000000002', 'Audit Rights', 0.9,
   'Customer has the right to audit Vendor''s books and records once per year.', 'pending', '', 'local_rule',
   'a0000000-0000-4000-8000-000000000001', NULL, NULL),

  ('b0000000-0000-4000-8000-000000000003', 'Insurance', 0.89,
   'Vendor will maintain commercial general liability insurance.', 'accepted', '', 'local_rule',
   'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003', '2026-10-09 10:40:00+00'),
  ('b0000000-0000-4000-8000-000000000003', 'Warranty Duration', 0.88,
   'The warranty period will continue for twelve months after delivery.', 'accepted', '', 'local_rule',
   'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003', '2026-10-09 10:45:00+00'),

  ('b0000000-0000-4000-8000-000000000004', 'Exclusivity', 0.9,
   'Vendor will serve as Customer''s exclusive provider for the covered services.', 'accepted', '', 'local_rule',
   'a0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000002', '2026-10-12 15:00:00+00'),
  ('b0000000-0000-4000-8000-000000000004', 'Uncapped Liability', 0.86,
   'Vendor''s indemnification obligations are not subject to the liability cap.', 'escalated',
   'Uncapped indemnity needs Legal sign-off.', 'local_rule',
   'a0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000002', '2026-10-12 15:10:00+00'),
  ('b0000000-0000-4000-8000-000000000004', 'Change Of Control', 0.75,
   'A change of control will be treated as an assignment.', 'accepted', 'Added during review.', 'manual',
   'a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', '2026-10-12 15:12:00+00');

INSERT INTO audit_events (actor_id, agreement_id, action, detail, created_at) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'agreement.submitted', '{}', '2026-10-20 14:05:00+00'),
  ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002', 'agreement.submitted', '{}', '2026-10-14 09:30:00+00'),
  ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000003', 'agreement.submitted', '{}', '2026-10-02 16:45:00+00'),
  ('a0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000003', 'agreement.approved', '{}', '2026-10-09 11:00:00+00'),
  ('a0000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000004', 'agreement.submitted', '{}', '2026-10-06 13:15:00+00'),
  ('a0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000004', 'agreement.escalated', '{"category":"Uncapped Liability"}', '2026-10-12 15:20:00+00');
