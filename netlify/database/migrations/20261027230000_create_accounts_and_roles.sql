-- KAN-21A: accounts, roles and the Approver permission.
--
-- Sign-in itself is Netlify Identity. This table is the application's own
-- record of each person, linked to their Identity account by `identity_id`
-- (the JWT `sub`). Seeded and pre-provisioned accounts start with a NULL
-- `identity_id` and are claimed by email on that person's first sign-in.
--
-- Roles: Requester, Reviewer, Administrator. A person may hold several.
-- Approver is not a role but an extra permission, granted only to someone who
-- already reviews (Reviewer or Administrator).

CREATE TYPE app_role AS ENUM ('requester', 'reviewer', 'administrator');
CREATE TYPE app_permission AS ENUM ('approve');

CREATE TABLE app_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id   text UNIQUE,
  email         text NOT NULL CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%'),
  display_name  text NOT NULL DEFAULT '',
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz
);

CREATE UNIQUE INDEX app_users_email_key ON app_users (email);

CREATE TABLE user_roles (
  user_id     uuid NOT NULL REFERENCES app_users (id) ON DELETE CASCADE,
  role        app_role NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  granted_by  uuid REFERENCES app_users (id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, role)
);

CREATE TABLE user_permissions (
  user_id     uuid NOT NULL REFERENCES app_users (id) ON DELETE CASCADE,
  permission  app_permission NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  granted_by  uuid REFERENCES app_users (id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, permission)
);

-- Approve is only meaningful for someone who reviews.
CREATE FUNCTION enforce_approver_requires_reviewer() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.permission = 'approve' AND NOT EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_id = NEW.user_id AND role IN ('reviewer', 'administrator')
  ) THEN
    RAISE EXCEPTION 'The Approver permission requires the Reviewer or Administrator role.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_permissions_require_reviewer
  BEFORE INSERT OR UPDATE ON user_permissions
  FOR EACH ROW EXECUTE FUNCTION enforce_approver_requires_reviewer();

-- Removing someone's last reviewing role also removes their approval right,
-- so the permission can never outlive the role it depends on.
CREATE FUNCTION revoke_orphaned_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role IN ('reviewer', 'administrator') AND NOT EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_id = OLD.user_id AND role IN ('reviewer', 'administrator')
  ) THEN
    DELETE FROM user_permissions WHERE user_id = OLD.user_id AND permission = 'approve';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER user_roles_revoke_orphaned_approval
  AFTER DELETE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION revoke_orphaned_approval();
