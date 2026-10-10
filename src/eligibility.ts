// Admission-time downstream policy. Never feed this result back into risk scoring.
// Unknown or inconsistent classification/decision pairs fail closed.
export function monetizationEligibility(classification: string, decision: string): boolean {
  return classification === "CLEAN" && decision === "WOULD_PASS";
}
