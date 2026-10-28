import { itemSubject } from '../cli/cli.ts';
import type { NeedView } from '../cli/cli.ts';
import { singleLine } from './rowList.tsx';
import type { DetailFact, ListRow } from './rowList.tsx';

const secondsPerMinute = 60;
const secondsPerHour = 3600;
const secondsPerDay = 86_400;

const ageLabelOf = (ageSeconds: number): string => {
  if (ageSeconds < secondsPerMinute) {
    return `${ageSeconds}s`;
  }

  if (ageSeconds < secondsPerHour) {
    return `${Math.floor(ageSeconds / secondsPerMinute)}m`;
  }

  if (ageSeconds < secondsPerDay) {
    return `${Math.floor(ageSeconds / secondsPerHour)}h`;
  }

  return `${Math.floor(ageSeconds / secondsPerDay)}d`;
};

const rowKey = (item: NeedView): string => {
  if (item.reason === 'blockedFinding') {
    return `${item.id}:${item.reason}:${item.fingerprint}`;
  }

  if (item.reason === 'question' || item.reason === 'submitted') {
    return `${item.id}:${item.reason}:${item.item}`;
  }

  return `${item.id}:${item.reason}`;
};

const ageFactsOf = (ageSeconds: number | null): DetailFact[] =>
  ageSeconds === null ? [] : [{ label: 'Age', value: ageLabelOf(ageSeconds) }];

const factsOf = (item: NeedView): DetailFact[] => [
  { label: 'ID', value: item.id },
  { label: 'Title', value: singleLine(item.title) },
  { label: 'Reason', value: item.reason },
  ...ageFactsOf(item.ageSeconds),
];

export const homeRowsOf = (items: readonly NeedView[]): ListRow[] =>
  items.map((item) => ({
    key: rowKey(item),
    id: item.id,
    text: `${item.id}  ${item.reason}  ${singleLine(itemSubject(item))}`,
    facts: factsOf(item),
  }));
