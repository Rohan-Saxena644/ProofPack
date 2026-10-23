export function allowedUrl(raw: string, origins: string[]) {
  try {
    const u = new URL(raw);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password &&
      !['169.254.169.254', 'metadata.google.internal', '100.100.100.200'].includes(u.hostname) && origins.includes(u.origin);
  } catch { return false; }
}
export function requireAllowed(raw: string, origins: string[]) {
  if (!allowedUrl(raw, origins)) throw new Error('Target URL is outside the explicitly allowed application origins.');
}
export function safeUrl(raw: string) {
  try { const u = new URL(raw); return u.origin + u.pathname; } catch { return '[invalid URL]'; }
}
