import { ApiError } from './errors.js';

/**
 * Who the request is acting as. A client never asserts this in production: the
 * principal is read from a verified token, and `:id` is only the resource being
 * asked for. This slice has no identity provider, so the adapter headers below
 * stand in for that claim and the routes still compare claim to resource.
 */
export interface TenantPrincipal {
  readonly kind: 'tenant';
  readonly customerId: string;
}

export interface AdminPrincipal {
  readonly kind: 'admin';
}

export function tenantPrincipal(claim: string | undefined): TenantPrincipal {
  if (claim === undefined || claim.length === 0) {
    throw new ApiError(
      401,
      'customer_identity_required',
      'X-Customer-Id is required',
    );
  }
  return { kind: 'tenant', customerId: claim };
}

export function adminPrincipal(claim: string | undefined): AdminPrincipal {
  if (claim !== 'true') {
    throw new ApiError(403, 'admin_required', 'X-Admin: true is required');
  }
  return { kind: 'admin' };
}

export function authorizeCustomer(
  principal: TenantPrincipal,
  customerId: string,
): void {
  if (principal.customerId !== customerId) {
    throw new ApiError(
      403,
      'tenant_mismatch',
      'Identity is not authorized for the requested customer',
    );
  }
}
