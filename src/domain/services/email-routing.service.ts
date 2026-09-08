import type {
  CloudflareAdapter,
  CloudflareEmailRoutingRule,
  CloudflareZone,
} from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import { findCloudflareZone, getCloudflareAdapterFromHints } from './cloudflare-ops.service.js';
import { formatConnectionGuidance } from './connection-guidance.js';
import { cloudflareScopeHintsForDomain } from './domain-scope.js';

type CloudflareEmailContext = {
  adapter: CloudflareAdapter;
  zone: CloudflareZone;
  accountId: string;
  provider: 'cloudflare';
};

export async function resolveCloudflareEmailContext(domain: string): Promise<CloudflareEmailContext | { error: string }> {
  const adapterResult = getCloudflareAdapterFromHints(cloudflareScopeHintsForDomain(domain));
  if ('error' in adapterResult) return { error: adapterResult.error };

  const zone = await findCloudflareZone(adapterResult.adapter, domain);
  if (!zone) {
    return {
      error: `Domain "${domain}" was not found in Cloudflare. Add the domain to Cloudflare or create a scoped Cloudflare connection for it.`,
    };
  }

  if (!zone.account?.id) {
    return {
      error: `Cloudflare zone "${domain}" did not include an account ID. Use an API token with Zone:Zone:Read plus Account Email Routing permissions. ${formatConnectionGuidance('cloudflare', { scope: domain })}`,
    };
  }

  return {
    adapter: adapterResult.adapter,
    zone,
    accountId: zone.account.id,
    provider: 'cloudflare',
  };
}

export function routingRuleForAddress(rule: CloudflareEmailRoutingRule, address: string): boolean {
  return rule.matchers.some((matcher) =>
    matcher.type === 'literal'
    && matcher.field === 'to'
    && matcher.value?.toLowerCase() === address.toLowerCase()
  );
}

export function forwardedTo(rule: CloudflareEmailRoutingRule): string[] {
  return rule.actions
    .filter((action) => action.type === 'forward')
    .flatMap((action) => action.value ?? []);
}

export function rulePayload(address: string, forwardTo: string) {
  return {
    name: `Forward ${address} to ${forwardTo}`,
    enabled: true,
    matchers: [{
      type: 'literal' as const,
      field: 'to' as const,
      value: address,
    }],
    actions: [{
      type: 'forward' as const,
      value: [forwardTo],
    }],
  };
}

export function catchAllPayload(action: 'drop' | 'forward', forwardTo: string | undefined, enabled: boolean) {
  return {
    name: action === 'forward' && forwardTo ? `Catch-all forward to ${forwardTo}` : 'Catch-all drop',
    enabled,
    matchers: [{ type: 'all' as const }],
    actions: action === 'forward'
      ? [{ type: 'forward' as const, value: [forwardTo!] }]
      : [{ type: 'drop' as const }],
  };
}
