/**
 * The rejection vocabulary, owned by neither side. Normalization picks a reason
 * from this list and the `ingest_rejections_reason_valid` CHECK constraint is
 * generated from it, so the database cannot accept a reason the code cannot
 * produce. It lives apart from the Drizzle schema so the ingest runtime does
 * not import an ORM it never calls.
 */
export const rejectionReasons = [
  'invalid_record',
  'missing_customer_id',
  'invalid_customer_id',
  'missing_event_type',
  'invalid_event_type',
  'missing_occurred_at',
  'ambiguous_occurred_at',
  'invalid_occurred_at',
  'invalid_endpoint',
  'invalid_user_email',
  'invalid_plan',
  'invalid_metadata',
  'invalid_duration_ms',
  'invalid_status',
] as const;

export type RejectionReason = (typeof rejectionReasons)[number];
