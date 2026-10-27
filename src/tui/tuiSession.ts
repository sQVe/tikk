import type { CliFailure, NeedsReading, TreeGroup } from '../cli/cli.ts';
import type { Result } from '../result.ts';
import { homeRowsOf } from './homeView.tsx';
import { topAfter } from './overlayScroll.ts';
import type { OverlayMove } from './overlayScroll.ts';
import type { ListRow } from './rowList.tsx';
import { treeRowsOf } from './treeView.tsx';

interface TicketFileError {
  path: string;
  message: string;
}

export interface TuiEffects {
  load: () => Promise<Result<NeedsReading, CliFailure>>;
  loadTree: () => Promise<Result<TreeGroup[], CliFailure>>;
  loadErrors: () => Promise<TicketFileError[]>;
  edit: (rawId: string) => Promise<Result<undefined, CliFailure>>;
  lend: <Value>(run: () => Promise<Value>) => Promise<Result<Value, 'cancelled'>>;
  onChange: (listener: () => void) => () => void;
}

type ViewName = 'home' | 'tree';

interface Selection {
  index: number;
  key: string | undefined;
  id: string | null | undefined;
}

interface ListView {
  requested: boolean;
  loaded: boolean;
  rows: readonly ListRow[];
  selection: Selection;
  failure: string | undefined;
  problems: readonly string[];
}

type Overlay = { kind: 'none' } | { kind: 'help'; top: number } | { kind: 'messages'; top: number };

export interface TuiMessage {
  id: number;
  text: string;
}

export interface TuiSnapshot {
  view: ViewName;
  views: Record<ViewName, ListView>;
  notice: string;
  messages: readonly TuiMessage[];
  overlay: Overlay;
  fileErrors: readonly TicketFileError[];
}

type OverlayIntent =
  | { kind: 'toggleHelp' }
  | { kind: 'openMessages' }
  | { kind: 'closeOverlay' }
  | { kind: 'scrollOverlay'; move: OverlayMove; maximumTop: number };

export type TuiIntent =
  | { kind: 'moveUp' }
  | { kind: 'moveDown' }
  | { kind: 'moveFirst' }
  | { kind: 'moveLast' }
  | { kind: 'switchView' }
  | { kind: 'edit' }
  | OverlayIntent;

// Intents that only change the snapshot, with no load or effect.
type LocalIntent = Exclude<TuiIntent, { kind: 'switchView' } | { kind: 'edit' }>;

export interface TuiSession {
  getSnapshot: () => TuiSnapshot;
  subscribe: (listener: () => void) => () => void;
  send: (intent: TuiIntent) => void;
  stop: () => void;
}

type LoadOutcome =
  | { ok: true; rows: ListRow[]; problems: readonly string[] }
  | { ok: false; message: string };

const emptyView: ListView = {
  requested: false,
  loaded: false,
  rows: [],
  selection: { index: 0, key: undefined, id: undefined },
  failure: undefined,
  problems: [],
};

const initialSnapshot: TuiSnapshot = {
  view: 'home',
  views: { home: { ...emptyView, requested: true }, tree: emptyView },
  notice: '',
  messages: [],
  overlay: { kind: 'none' },
  fileErrors: [],
};

const messageLimit = 100;

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

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

const withView = (snapshot: TuiSnapshot, name: ViewName, view: ListView): TuiSnapshot => ({
  ...snapshot,
  views: { ...snapshot.views, [name]: view },
});

const applyLoad = (snapshot: TuiSnapshot, name: ViewName, outcome: LoadOutcome): TuiSnapshot => {
  const view = snapshot.views[name];

  if (!outcome.ok) {
    return withView(snapshot, name, { ...view, failure: outcome.message });
  }

  const { rows, problems } = outcome;
  const selection = selectionAt(rows, repairedIndex(view.selection, rows));

  return withView(snapshot, name, {
    ...view,
    loaded: true,
    rows,
    selection,
    failure: undefined,
    problems,
  });
};

const selectRow = (snapshot: TuiSnapshot, target: number): TuiSnapshot => {
  const view = snapshot.views[snapshot.view];
  const index = clampedIndex(target, view.rows.length);

  if (index === view.selection.index) {
    return snapshot;
  }

  return withView(snapshot, snapshot.view, { ...view, selection: selectionAt(view.rows, index) });
};

const moveSelection = (snapshot: TuiSnapshot, step: number): TuiSnapshot =>
  selectRow(snapshot, snapshot.views[snapshot.view].selection.index + step);

const overlayAfter = (overlay: Overlay, intent: OverlayIntent): Overlay => {
  if (intent.kind === 'toggleHelp') {
    return overlay.kind === 'help' ? { kind: 'none' } : { kind: 'help', top: 0 };
  }

  if (intent.kind === 'openMessages') {
    return { kind: 'messages', top: 0 };
  }

  if (intent.kind === 'closeOverlay') {
    return { kind: 'none' };
  }

  return overlay.kind === 'none'
    ? overlay
    : { ...overlay, top: topAfter(overlay.top, intent.move, intent.maximumTop) };
};

const snapshotAfter = (snapshot: TuiSnapshot, intent: LocalIntent): TuiSnapshot => {
  if (intent.kind === 'moveUp') {
    return moveSelection(snapshot, -1);
  }

  if (intent.kind === 'moveDown') {
    return moveSelection(snapshot, 1);
  }

  if (intent.kind === 'moveFirst') {
    return selectRow(snapshot, 0);
  }

  if (intent.kind === 'moveLast') {
    return selectRow(snapshot, snapshot.views[snapshot.view].rows.length - 1);
  }

  return { ...snapshot, overlay: overlayAfter(snapshot.overlay, intent) };
};

const followedSelection = (target: ListView, id: Selection['id']): Selection => {
  if (!target.loaded) {
    return { ...target.selection, key: undefined, id };
  }

  const index = indexOfTicket(target.rows, id);

  return index === -1 ? target.selection : selectionAt(target.rows, index);
};

const switchView = (snapshot: TuiSnapshot): TuiSnapshot => {
  const name: ViewName = snapshot.view === 'home' ? 'tree' : 'home';
  const target = snapshot.views[name];
  const selection = followedSelection(target, snapshot.views[snapshot.view].selection.id);

  return { ...withView(snapshot, name, { ...target, requested: true, selection }), view: name };
};

const homeOutcome = (result: Result<NeedsReading, CliFailure>): LoadOutcome =>
  result.ok
    ? {
        ok: true,
        rows: homeRowsOf(result.value.items),
        problems: result.value.reconcileProblems.map((problem) => problem.message),
      }
    : { ok: false, message: result.reason.message };

const treeOutcome = (result: Result<TreeGroup[], CliFailure>): LoadOutcome =>
  result.ok
    ? { ok: true, rows: treeRowsOf(result.value), problems: [] }
    : { ok: false, message: result.reason.message };

const readView = async (effects: TuiEffects, name: ViewName): Promise<LoadOutcome> => {
  try {
    return name === 'home'
      ? homeOutcome(await effects.load())
      : treeOutcome(await effects.loadTree());
  } catch (error) {
    return { ok: false, message: errorMessage(error, 'The list did not load.') };
  }
};

// The views report their own load failures, so a failed listing keeps the previous errors.
const readFileErrors = async (effects: TuiEffects): Promise<TicketFileError[] | undefined> => {
  try {
    return await effects.loadErrors();
  } catch {
    return undefined;
  }
};

export const createTuiSession = (effects: TuiEffects): TuiSession => {
  const listeners = new Set<() => void>();
  const latestLoad: Record<ViewName, number> = { home: 0, tree: 0 };
  let latestReload = 0;
  let snapshot = initialSnapshot;
  let queue: Promise<void> = Promise.resolve();
  let stopped = false;
  let lastMessageId = 0;

  const update = (next: TuiSnapshot) => {
    if (stopped || next === snapshot) {
      return;
    }

    snapshot = next;

    for (const listener of listeners) {
      listener();
    }
  };

  // A failed action must not stop the actions queued after it. Shutdown closes the effects after
  // stop, so no queued action may start then.
  const enqueue = (action: () => Promise<void>) => {
    const running = queue.then(() => (stopped ? undefined : action()));

    queue = running.catch(() => undefined);
  };

  // One request is one action, so its views change in a single transition.
  const requestLoad = (names: readonly ViewName[]) => {
    const requests = names.map((name) => {
      latestLoad[name] += 1;

      return { name, request: latestLoad[name] };
    });

    latestReload += 1;

    const reload = latestReload;

    enqueue(async () => {
      const outcomes = await Promise.all(
        requests.map(async ({ name, request }) => ({
          name,
          request,
          outcome: await readView(effects, name),
        })),
      );

      if (stopped) {
        return;
      }

      const fileErrors = await readFileErrors(effects);
      const current = outcomes.filter(({ name, request }) => request === latestLoad[name]);

      const next = current.reduce(
        (reached, { name, outcome }) => applyLoad(reached, name, outcome),
        snapshot,
      );

      const isLatest = reload === latestReload;
      const publishesErrors = isLatest && fileErrors !== undefined;

      update(publishesErrors ? { ...next, fileErrors } : next);
    });
  };

  const reload = () => {
    const names = (['home', 'tree'] as const).filter((name) => snapshot.views[name].requested);

    requestLoad(names);
  };

  const showNotice = (notice: string) => {
    if (notice === '') {
      update({ ...snapshot, notice });

      return;
    }

    lastMessageId += 1;

    const messages = [{ id: lastMessageId, text: notice }, ...snapshot.messages];

    update({ ...snapshot, notice, messages: messages.slice(0, messageLimit) });
  };

  const edit = () => {
    const { id } = snapshot.views[snapshot.view].selection;

    if (typeof id !== 'string') {
      return;
    }

    effects
      .lend(() => effects.edit(id))
      .then((loan) => {
        if (loan.ok) {
          showNotice(loan.value.ok ? '' : loan.value.reason.message);
        }
      })
      .catch((error: unknown) => {
        showNotice(errorMessage(error, 'The editor did not run.'));
      });
  };

  const send = (intent: TuiIntent) => {
    if (stopped) {
      return;
    }

    if (intent.kind === 'switchView') {
      const loadsTree = !snapshot.views.tree.requested;

      update(switchView(snapshot));

      if (loadsTree) {
        requestLoad(['tree']);
      }
    } else if (intent.kind === 'edit') {
      edit();
    } else {
      update(snapshotAfter(snapshot, intent));
    }
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  };

  const stopChanges = effects.onChange(reload);

  const stop = () => {
    stopped = true;
    stopChanges();
  };

  reload();

  return { getSnapshot: () => snapshot, subscribe, send, stop };
};
