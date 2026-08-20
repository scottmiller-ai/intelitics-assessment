DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'migrator') THEN
    CREATE ROLE migrator LOGIN PASSWORD 'migrator';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ingest_app') THEN
    CREATE ROLE ingest_app LOGIN PASSWORD 'ingest_app';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tenant_app') THEN
    CREATE ROLE tenant_app LOGIN PASSWORD 'tenant_app';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'billing_admin') THEN
    CREATE ROLE billing_admin LOGIN PASSWORD 'billing_admin';
  END IF;
END
$$;

ALTER ROLE migrator WITH LOGIN PASSWORD 'migrator' NOBYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE ingest_app WITH LOGIN PASSWORD 'ingest_app' BYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE tenant_app WITH LOGIN PASSWORD 'tenant_app' NOBYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE billing_admin WITH LOGIN PASSWORD 'billing_admin' BYPASSRLS NOCREATEDB NOCREATEROLE;

ALTER ROLE migrator SET search_path = app, public;
ALTER ROLE ingest_app SET search_path = app, public;
ALTER ROLE tenant_app SET search_path = app, public;
ALTER ROLE billing_admin SET search_path = app, public;

DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO migrator, ingest_app, tenant_app, billing_admin',
    current_database()
  );
  EXECUTE format(
    'GRANT CREATE ON DATABASE %I TO migrator',
    current_database()
  );
END
$$;

CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION migrator;
ALTER SCHEMA app OWNER TO migrator;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO ingest_app, tenant_app, billing_admin;
