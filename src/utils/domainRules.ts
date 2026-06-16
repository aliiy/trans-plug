/**
 * Domain-based translation rules.
 * Stores per-domain preferences: 'always' | 'never' | 'default'.
 * Supports wildcard patterns like "*.example.com".
 */

export type DomainAction = 'always' | 'never';

const STORAGE_KEY = 'domainRules';

export interface DomainRules {
  [pattern: string]: DomainAction;
}

/** Fetch all domain rules from storage. */
export async function getDomainRules(): Promise<DomainRules> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as DomainRules) ?? {};
}

/** Determine what action to take for a given hostname. */
export async function getDomainAction(
  hostname: string
): Promise<DomainAction | 'default'> {
  const rules = await getDomainRules();

  // Exact match takes priority
  if (rules[hostname]) return rules[hostname];

  // Check wildcard patterns
  for (const [pattern, action] of Object.entries(rules)) {
    if (matchesPattern(pattern, hostname)) {
      return action;
    }
  }

  return 'default';
}

/** Set a domain rule. Pass 'default' to remove the rule. */
export async function setDomainRule(
  hostname: string,
  action: DomainAction | 'default'
): Promise<void> {
  const rules = await getDomainRules();
  if (action === 'default') {
    delete rules[hostname];
  } else {
    rules[hostname] = action;
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: rules });
}

/** Check if a hostname matches a pattern. "*" wildcard supported as prefix. */
function matchesPattern(pattern: string, hostname: string): boolean {
  if (pattern === hostname) return true;
  // "*.example.com" matches "sub.example.com" but not "example.com"
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // ".example.com"
    return hostname.endsWith(suffix) && hostname !== suffix.slice(1);
  }
  return false;
}

/** Extract the effective domain from a full hostname for display. */
export function getBaseDomain(hostname: string): string {
  // Remove common subdomain prefixes for display purposes
  const parts = hostname.split('.');
  if (parts.length > 2) {
    // Check for country-code second-level domains
    const tld = parts[parts.length - 1];
    const sld = parts[parts.length - 2];
    if (tld.length === 2 && ['co', 'com', 'org', 'net', 'gov', 'edu'].includes(sld)) {
      return parts.slice(-3).join('.');
    }
    return parts.slice(-2).join('.');
  }
  return hostname;
}
