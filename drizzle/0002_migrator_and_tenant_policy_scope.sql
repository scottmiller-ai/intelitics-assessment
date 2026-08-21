-- `tenant_isolation` was created with no TO clause, which means PUBLIC. Under
-- FORCE ROW LEVEL SECURITY that includes the table owner, so `migrator` was
-- subject to a policy keyed on a GUC that migrations never set. Every row was
-- invisible to it, and DML reported success while changing nothing:
--
--   migrator=> update app.usage_events set duration_ms = duration_ms;
--   UPDATE 0
--
-- A backfill, a unit correction, or an erasure request would have passed CI and
-- done nothing. Scope the tenant policy to the role that needs it and state the
-- migrator's access explicitly. FORCE still holds: no role escapes policy, and
-- the migrator's reach is now a grant in a migration rather than a side effect
-- of ownership, so it is visible in `pg_policies` and revocable.
ALTER POLICY tenant_isolation ON app.customers TO tenant_app;--> statement-breakpoint
ALTER POLICY tenant_isolation ON app.usage_events TO tenant_app;--> statement-breakpoint

CREATE POLICY migrator_maintenance ON app.customers
  FOR ALL
  TO migrator
  USING (true)
  WITH CHECK (true);--> statement-breakpoint

CREATE POLICY migrator_maintenance ON app.usage_events
  FOR ALL
  TO migrator
  USING (true)
  WITH CHECK (true);
