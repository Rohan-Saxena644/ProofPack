export function assertionOutcome(
  requiredIds: string[],
  results: { specId: string; passed: boolean }[],
): 'passed' | 'failed' | 'blocked' {
  if (results.some((a) => !a.passed)) return 'failed';
  return requiredIds.length > 0 &&
    requiredIds.every((id) => results.some((a) => a.specId === id && a.passed))
    ? 'passed'
    : 'blocked';
}
