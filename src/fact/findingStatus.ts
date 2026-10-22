import type { Fact } from './factLine.ts';

type ReviewFact = Extract<Fact, { kind: 'review' }>;

type FindingStatusName = Extract<Fact, { kind: 'finding' }>['status'];

export interface FindingEntry {
  fingerprint: string;
  severity: ReviewFact['findings'][number]['severity'];
  location: string;
  claim: string;
  status: FindingStatusName;
  match: 'new' | 'unchanged' | 'absent';
}

const matchOf = (fingerprint: string, reviews: ReviewFact[]): FindingEntry['match'] => {
  const newest = reviews.at(-1);
  const inNewest = newest?.findings.some((finding) => finding.fingerprint === fingerprint);

  if (inNewest !== true) {
    return 'absent';
  }

  const inEarlier = reviews
    .slice(0, -1)
    .some((review) => review.findings.some((finding) => finding.fingerprint === fingerprint));

  return inEarlier ? 'unchanged' : 'new';
};

const statusOf = (own: Fact[], fingerprint: string): FindingStatusName => {
  const statusFact = own.findLast(
    (fact) => fact.kind === 'finding' && fact.fingerprint === fingerprint,
  );

  return statusFact?.kind === 'finding' ? statusFact.status : 'open';
};

export const selectFindings = (facts: Fact[], ticketId: string): FindingEntry[] => {
  const own = facts.filter((fact) => fact.ticket === ticketId);
  const reviews = own.filter((fact): fact is ReviewFact => fact.kind === 'review');
  const latest = new Map<string, ReviewFact['findings'][number]>();

  for (const review of reviews) {
    for (const finding of review.findings) {
      latest.set(finding.fingerprint, finding);
    }
  }

  return [...latest.values()].map((finding) =>
    Object.assign({}, finding, {
      status: statusOf(own, finding.fingerprint),
      match: matchOf(finding.fingerprint, reviews),
    }),
  );
};
