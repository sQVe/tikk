import type { TaskTicket } from './taskState.ts';

export const compareRank = (left: TaskTicket, right: TaskTicket): number => {
  const leftRank = left.frontMatter.rank;
  const rightRank = right.frontMatter.rank;

  if (leftRank !== undefined && rightRank !== undefined && leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  if ((leftRank === undefined) !== (rightRank === undefined)) {
    return leftRank === undefined ? 1 : -1;
  }

  return left.id < right.id ? -1 : Number(left.id > right.id);
};
