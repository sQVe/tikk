interface CriterionText {
  check: string;
  expected: string;
}

// The JSON array keeps check and expected apart, so text moved between them changes the hash.
export const criterionFingerprint = ({ check, expected }: CriterionText): string =>
  new Bun.CryptoHasher('sha256').update(JSON.stringify([check, expected])).digest('hex');
