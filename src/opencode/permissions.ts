export interface SessionPermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny" | "ask";
}

const SENSITIVE_DENY_RULES: readonly SessionPermissionRule[] = [
  { action: "*", resource: "*.env", effect: "deny" },
  { action: "*", resource: "*.env.*", effect: "deny" },
  { action: "*", resource: "*/.env", effect: "deny" },
  { action: "*", resource: "*/.env.*", effect: "deny" },
  { action: "*", resource: "*.pem", effect: "deny" },
  { action: "*", resource: "*.key", effect: "deny" },
  { action: "*", resource: "*.p12", effect: "deny" },
  { action: "*", resource: "*.pfx", effect: "deny" },
  { action: "*", resource: "*id_rsa*", effect: "deny" },
  { action: "*", resource: "*id_ed25519*", effect: "deny" },
  { action: "*", resource: "*credentials*", effect: "deny" },
  { action: "*", resource: ".git/*", effect: "deny" },
  { action: "*", resource: "*/.git/*", effect: "deny" },
  { action: "*", resource: "*/.ssh/*", effect: "deny" },
  { action: "*", resource: "*/.aws/*", effect: "deny" },
  { action: "*", resource: "*/.gnupg/*", effect: "deny" },
  { action: "*", resource: "*/.config/gh/*", effect: "deny" },
  { action: "*", resource: "*/.cargo/credentials*", effect: "deny" },
  { action: "*", resource: "/etc/*", effect: "deny" },
  { action: "*", resource: "/proc/*", effect: "deny" },
  { action: "*", resource: "*..*", effect: "deny" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  { action: "grep", resource: "*.env.example", effect: "allow" },
];

// Why: In @opencode/schema (session.d.ts), `SessionCreateInput.permissions` is
// evaluated after the agent's default rules (`* -> allow`) and the last matching
// rule wins. Starting with `{ action: "*", resource: "*", effect: "deny" }`
// revokes write, edit, shell, browser, and interactive question tools; allowing
// `read`, `grep`, and `glob` enables repository navigation; and trailing `deny`
// rules with `action: "*"` on sensitive patterns prevent secret reads or greps
// without triggering an interactive `"ask"` prompt.
export const READONLY_SESSION_PERMISSIONS: readonly SessionPermissionRule[] = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  ...SENSITIVE_DENY_RULES,
];

export function buildReadOnlySessionPermissions(
  repoRoot?: string,
): readonly SessionPermissionRule[] {
  if (!repoRoot) {
    return READONLY_SESSION_PERMISSIONS;
  }
  const normalizedRoot = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  return [
    { action: "*", resource: "*", effect: "deny" },
    // Allow absolute paths strictly inside repoRoot plus relative repo paths (not starting with `/`)
    { action: "read", resource: `${normalizedRoot}/*`, effect: "allow" },
    { action: "grep", resource: `${normalizedRoot}/*`, effect: "allow" },
    { action: "glob", resource: `${normalizedRoot}/*`, effect: "allow" },
    { action: "read", resource: "[^/]*", effect: "allow" },
    { action: "grep", resource: "[^/]*", effect: "allow" },
    { action: "glob", resource: "[^/]*", effect: "allow" },
    ...SENSITIVE_DENY_RULES,
  ];
}

function globToRegExp(pattern: string): RegExp {
  if (pattern === "*") {
    return /^.*$/;
  }
  if (pattern === "[^/]*") {
    return /^[^/].*$/;
  }
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

export function evaluatePermissionRule(
  rules: readonly SessionPermissionRule[],
  action: string,
  resource: string,
): "allow" | "deny" | "ask" {
  let effect: "allow" | "deny" | "ask" = "allow";
  for (const rule of rules) {
    const actionMatches = rule.action === "*" || rule.action === action;
    const resourceMatches = globToRegExp(rule.resource).test(resource);
    if (actionMatches && resourceMatches) {
      effect = rule.effect;
    }
  }
  return effect;
}
