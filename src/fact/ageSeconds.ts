const millisecondsPerSecond = 1000;

export const ageSecondsOf = (since: string, now: Date): number =>
  Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / millisecondsPerSecond));
