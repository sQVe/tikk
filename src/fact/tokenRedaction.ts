const secretPatterns: RegExp[] = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bxox[a-z]-[A-Za-z0-9-]{10,}/g,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{10,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(?<=:\/\/)[^\s/@]+(?=@)/g,
];

export const redactSecrets = (text: string): string =>
  secretPatterns.reduce((result, pattern) => result.replace(pattern, '[redacted]'), text);
