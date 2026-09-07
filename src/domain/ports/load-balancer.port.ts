/**
 * Provider-neutral load-balancer lifecycle boundary.
 *
 * Monitors, pools, and public load balancers are deliberately separate: each
 * resource receives its own reviewed plan action and durable provider id.
 */

export interface LoadBalancerMonitor {
  id: string;
  name: string;
  type: string;
  path: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  expectedCodes: string;
  followRedirects: boolean;
}

export interface LoadBalancerOrigin {
  name: string;
  address: string;
  hostHeader: string;
  enabled: boolean;
}

export interface LoadBalancerPool {
  id: string;
  name: string;
  monitorId: string;
  origins: LoadBalancerOrigin[];
  enabled: boolean;
  steering: string;
}

export interface ManagedLoadBalancer {
  id: string;
  hostname: string;
  poolId: string;
  fallbackPoolId: string;
  enabled: boolean;
  proxied: boolean;
  steering: string;
}

export interface LoadBalancerScope {
  accountId: string;
  zoneId: string;
}

export interface LoadBalancerEnsureResult<T> {
  /** Exact provider identity returned by the acknowledged mutation. */
  resource: T;
  created: boolean;
  /** True only after the adapter re-observed the exact desired resource. */
  verified: boolean;
  /** Safe provider-owned reason when read-after-write did not converge. */
  verificationError?: string;
}

export interface ILoadBalancerAdapter {
  readonly name: string;
  resolveLoadBalancerScope(hostname: string): Promise<LoadBalancerScope>;

  findMonitorsByName(accountId: string, name: string): Promise<LoadBalancerMonitor[]>;
  getMonitor(accountId: string, id: string): Promise<LoadBalancerMonitor | null>;
  ensureMonitor(accountId: string, desired: Omit<LoadBalancerMonitor, 'id'>, id?: string): Promise<LoadBalancerEnsureResult<LoadBalancerMonitor>>;
  deleteMonitor(accountId: string, id: string): Promise<void>;

  findPoolsByName(accountId: string, name: string): Promise<LoadBalancerPool[]>;
  getPool(accountId: string, id: string): Promise<LoadBalancerPool | null>;
  ensurePool(accountId: string, desired: Omit<LoadBalancerPool, 'id'>, id?: string): Promise<LoadBalancerEnsureResult<LoadBalancerPool>>;
  deletePool(accountId: string, id: string): Promise<void>;

  findLoadBalancersByHostname(zoneId: string, hostname: string): Promise<ManagedLoadBalancer[]>;
  getLoadBalancer(zoneId: string, id: string): Promise<ManagedLoadBalancer | null>;
  ensureLoadBalancer(zoneId: string, desired: Omit<ManagedLoadBalancer, 'id'>, id?: string): Promise<LoadBalancerEnsureResult<ManagedLoadBalancer>>;
  deleteLoadBalancer(zoneId: string, id: string): Promise<void>;
}

export function supportsLoadBalancer(adapter: unknown): adapter is ILoadBalancerAdapter {
  if (!adapter || typeof adapter !== 'object') return false;
  const candidate = adapter as Partial<ILoadBalancerAdapter>;
  return typeof candidate.resolveLoadBalancerScope === 'function'
    && typeof candidate.findMonitorsByName === 'function'
    && typeof candidate.getMonitor === 'function'
    && typeof candidate.ensureMonitor === 'function'
    && typeof candidate.deleteMonitor === 'function'
    && typeof candidate.findPoolsByName === 'function'
    && typeof candidate.getPool === 'function'
    && typeof candidate.ensurePool === 'function'
    && typeof candidate.deletePool === 'function'
    && typeof candidate.findLoadBalancersByHostname === 'function'
    && typeof candidate.getLoadBalancer === 'function'
    && typeof candidate.ensureLoadBalancer === 'function'
    && typeof candidate.deleteLoadBalancer === 'function';
}
