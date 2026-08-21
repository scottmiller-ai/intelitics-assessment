-- billing_admin previously read across tenants because the role carried
-- BYPASSRLS, which is database-wide, permanent, and invisible from the schema.
-- The permission it actually needs is "read every row of one table", so state
-- exactly that. Policies are permissive, so this ORs with tenant_isolation:
-- billing_admin sees all rows, tenant_app still sees only its own.
CREATE POLICY billing_admin_read ON app.usage_events
  FOR SELECT
  TO billing_admin
  USING (true);
