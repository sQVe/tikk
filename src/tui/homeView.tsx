import type { NeedView } from '../cli/cli.ts';
import { singleLine } from './rowList.tsx';
import type { ListRow } from './rowList.tsx';

export const homeRowsOf = (items: readonly NeedView[]): ListRow[] =>
  items.map((item) => ({
    key: `${item.id}:${item.reason}`,
    id: item.id,
    text: `${item.id}  ${item.reason}  ${singleLine(item.title)}`,
  }));
