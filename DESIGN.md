# Design

One Node process, one Postgres database, one shared schema. Ingest hashes a
source, normalizes every row to a fact or a rejection, and commits the whole
result in one transaction. HTTP answers three named billing questions over those
facts.

## Schema design

`usage_events` is one wide fact table. `customers` is tenant identity only.
`ingest_sources` and `ingest_rejections` are lineage. Users, endpoints, event
types, plans, and statuses are columns on the event, not tables.

That is the one-big-table choice. The other side was a star: catalogs for
users, endpoints, plans, and a mapping from event type to route. Billing reads
are counts and sums over a time window, filtered and grouped by attributes the
event already carries. Extra tables would add a join to every invoice query, and
we were not given those entities to store. A new plan name would then be an
ingest failure instead of a new string. Normalization waits until something
other than the event is authoritative.

What did earn a table: customer id, because RLS and a foreign key need a target;
and the source, because duplicate delivery is a property of a file, not a row.

Customer ids stay producer ids. No UUID rewrite. A `customers` row appears the
first time an event carries that id. No name, plan, or signup date was supplied,
so there is nothing else to put there. The cost is that an id with no usage
cannot be told from an id that was never a customer. Both answer `404`, and the
message says no usage has been recorded. A real zero-usage customer is a billing
answer this service cannot give until an authoritative registry exists.

Each event stores the plan reported on that event. It does not set a customer's
current plan. Inferring current plan from usage was refused. Authoritative plan
history is a subscription concern; each query names which source it uses.

Duration and status are columns. The rest of `metadata` stays JSONB. Malformed
optional values are rejected, not coerced to null. Missing values are accepted
where the contract allows them. Timestamps without a zone are rejected. Stored
values are UTC. Windows are half-open `[from, to)`.

Source identity is SHA-256 of the exact bytes. Filename is not identity. The
same bytes under a new name are a skip. Facts, rejections, customers, and the
source row commit together, so a crash cannot leave a billed subset.
`ingest_hash` is delivery dedup, not a producer event id. Identical content
without a producer id cannot be distinguished from a retry. First row in source
order wins. `(source_id, source_index)` is lineage for later replay. It is not
unique until a second writer or a policy replay exists. Replay, when it exists,
writes staging and compares; it does not rewrite live billing history.

Indexes cover a tenant window, a cross-tenant window, and the two unique hashes.
Those are the filters the three questions use.

The HTTP surface is those three questions, not a cube. Usage is event count and
total duration. `/customers/{id}/usage` returns that metric. A decomposition is
opt-in by name, or it is its own route when a bucket is not enough — user email
because it is PII, endpoint because the brief asked for latency shape. All
accepted events count. No `is_billable` rule was supplied, so status is a
grouping, not a filter. Ranked results sort by event count, then duration, then
the dimension value, so ties do not shuffle.

## Multi-tenancy

Isolation has to hold in the database, not only in `WHERE customer_id =`.

Shared `app` schema. Four roles. `PUBLIC` has no access. Runtime roles do not
own tables.

- `ingest_app` writes mixed-tenant sources and bypasses RLS. It is the only
  bypass: one source contains many tenants and has no single id to scope to.
  No DDL, no updates.
- `tenant_app` reads rows allowed by RLS. No bypass.
- `billing_admin` reads every row of `usage_events` through a `SELECT` policy on
  that table, not a role-wide bypass. The grant is one table, visible in the
  schema, revocable in a migration. No writes, no `customers`, no ingest tables.
- `migrator` owns schema changes, under a policy of its own. RLS is forced,
  including for the table owner, so ownership is not an escape.

`tenant_app` sees rows matching `current_setting('app.current_customer_id', true)`.
A missing setting returns no rows.

A tenant request is one connection and one repeatable-read transaction: set the
GUC locally, confirm usage exists, run the query, commit. The setting is
transaction-local, so it cannot leak to the next borrower of the pool. Queries
also filter `customer_id` in SQL. Repeatable read is for the seam between the
existence check and the aggregate. Each aggregate is one statement.

`X-Customer-Id` and `X-Admin: true` are local adapters. A client must never
assert its own tenant. With real authentication the header is deleted and `:id`
is checked against a verified claim. RLS still enforces tenancy. It does not
enforce permissions.

Schema-per-tenant was refused. Hundreds of customers with wildly different
volumes is a hot-tenant problem, not a schema problem. The first lever, once
measured, is partitioning `usage_events` by `occurred_at`: every billing read is
a time window, and closed months can detach. If one tenant is the outlier, move
that tenant. Rollups wait on the same measurement.

## Operating it

Observability in this slice is the ingest path. Status mix, endpoint error
rates, and client latency already belong at the origin. This service's job is
to say whether a source became billing facts, and how much of it did not.

What shipped: one JSON summary per source. Source identity, skip or duplicate,
accepted count, duplicate count, rejections by reason. Fastify request logs
exist for the HTTP side. They are not the paging story.

Day two exports those ingest counters as metrics. File parse failure (the
bytes are not UTF-8 JSON) is a source-level failure: nothing from that file
landed. A high normalization-rejection rate is a policy or producer-contract
failure: the file parsed, but rows could not become facts. Those two are the
alarms. One rejected row is not. The row is already in `ingest_rejections`.

Page at 2am when ingest has stopped completing sources inside the billing SLA,
when parse failures spike, or when rejection rate spikes. Do not page on
Postgres from this service until `/health` is red; that check only proves the
serving pools can reach their tables. It is not ingest health.

Not this pass: tenant fields on request logs, redacting stacks and emails,
pool acquire timeouts, pagination on drilldowns. Serving statements already
cap at fifteen seconds. Ingest does not, because it holds one transaction for
the whole source.

## What I'd do next

Producer event ids. `ingest_hash` cannot tell a retry from a second event with
the same body. A later source that collides is skipped forever. Billing needs
the producer id, then per-source uniqueness and a replay path with it, not
before it.

Then export the ingest counters and stop holding one transaction open for a
whole source. The persist path is already `persist(normalize())`. A queue
driver or chunked commit changes one layer.

Then an authoritative customer registry, so zero usage is a real 200, and plan
history has a home that is not the fact table.

Not this pass: prices, an `is_billable` rule, inferring tenant from email,
inferring current plan from usage, dimension catalogs, arbitrary cubes,
schema-per-tenant, a second ingest product, production authentication.
