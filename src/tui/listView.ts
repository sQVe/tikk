import type { ListRow } from './rowList.tsx';

interface Selection {
  index: number;
  key: string | undefined;
  id: string | null | undefined;
}

export interface ListView {
  requested: boolean;
  loaded: boolean;
  rows: readonly ListRow[];
  selection: Selection;
  failure: string | undefined;
  problems: readonly string[];
}

export const emptyView: ListView = {
  requested: false,
  loaded: false,
  rows: [],
  selection: { index: 0, key: undefined, id: undefined },
  failure: undefined,
  problems: [],
};

const clampedIndex = (index: number, count: number): number =>
  Math.max(0, Math.min(count - 1, index));

const selectionAt = (rows: readonly ListRow[], index: number): Selection => ({
  index,
  key: rows[index]?.key,
  id: rows[index]?.id,
});

const indexOfTicket = (rows: readonly ListRow[], id: Selection['id']): number =>
  rows.findIndex((row) => row.id === id);

const repairedIndex = (selection: Selection, rows: readonly ListRow[]): number => {
  const byKey = rows.findIndex((row) => row.key === selection.key);

  if (byKey !== -1) {
    return byKey;
  }

  const byTicket = indexOfTicket(rows, selection.id);

  return byTicket === -1 ? clampedIndex(selection.index, rows.length) : byTicket;
};

export const listWithRows = (
  view: ListView,
  rows: readonly ListRow[],
  problems: readonly string[],
): ListView => {
  const selection = selectionAt(rows, repairedIndex(view.selection, rows));

  return { ...view, loaded: true, rows, selection, problems };
};

export const listAt = (view: ListView, target: number): ListView => {
  const index = clampedIndex(target, view.rows.length);

  if (index === view.selection.index) {
    return view;
  }

  return { ...view, selection: selectionAt(view.rows, index) };
};

export const followedSelection = (target: ListView, id: Selection['id']): Selection => {
  if (!target.loaded) {
    return { ...target.selection, key: undefined, id };
  }

  const index = indexOfTicket(target.rows, id);

  return index === -1 ? target.selection : selectionAt(target.rows, index);
};
