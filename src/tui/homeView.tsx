import { itemSubject } from '../cli/cli.ts';
import type { NeedView } from '../cli/cli.ts';
import { singleLine } from './rowList.tsx';
import type { ListRow } from './rowList.tsx';

const rowKey = (item: NeedView): string =>
  item.reason === 'blockedFinding'
    ? `${item.id}:${item.reason}:${item.fingerprint}`
    : `${item.id}:${item.reason}`;

export const homeRowsOf = (items: readonly NeedView[]): ListRow[] =>
  items.map((item) => ({
    key: rowKey(item),
    id: item.id,
    text: `${item.id}  ${item.reason}  ${singleLine(itemSubject(item))}`,
  }));
