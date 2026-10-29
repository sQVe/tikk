import type { CliFailure, NeedView, NeedsReading, ProjectTree } from '../cli/cli.ts';
import type { Result } from '../result.ts';
import {
  createDetailLoader,
  detailAfter,
  detailAfterLoad,
  detailAfterReload,
  detailAfterSelect,
  noDetail,
} from './detailState.ts';
import type { DetailIntent, DetailState, LoadDetail } from './detailState.ts';
import { strayErrorsOf } from './fileErrors.ts';
import type { TicketFileError } from './fileErrors.ts';
import { homeRowsOf } from './homeView.tsx';
import { emptyView, followedSelection, listAt, listWithRows } from './listView.ts';
import type { ListView } from './listView.ts';
import { topAfter } from './overlayScroll.ts';
import type { OverlayMove } from './overlayScroll.ts';
import { foldsAfter, foldsAfterLoad, noFolds, projectRowsOf } from './projectTree.ts';
import type { FoldIntent, FoldState } from './projectTree.ts';
import type { ListRow } from './rowList.tsx';

export interface TuiEffects {
  load: () => Promise<Result<NeedsReading, CliFailure>>;
  loadTree: () => Promise<Result<ProjectTree, CliFailure>>;
  loadErrors: () => Promise<Result<TicketFileError[], CliFailure>>;
  loadDetail: LoadDetail;
  edit: (rawId: string) => Promise<Result<undefined, CliFailure>>;
  editDesign: (rawId: string) => Promise<Result<undefined, CliFailure>>;
  lend: <Value>(run: () => Promise<Value>) => Promise<Result<Value, 'cancelled'>>;
  onChange: (listener: () => void) => () => void;
  notices: readonly string[];
}

type ViewName = 'home' | 'tree';

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
  detailOpen: boolean;
  fileErrors: readonly TicketFileError[];
  needs: readonly NeedView[];
  projectTree: ProjectTree | undefined;
  folds: FoldState;
  detail: DetailState;
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
  | { kind: 'editDesign' }
  | { kind: 'openDetail' }
  | { kind: 'closeDetail' }
  | { kind: 'fold'; fold: FoldIntent }
  | DetailIntent
  | OverlayIntent;

type LocalIntent = Exclude<
  TuiIntent,
  { kind: 'switchView' } | { kind: 'edit' } | { kind: 'editDesign' }
>;

export interface TuiSession {
  getSnapshot: () => TuiSnapshot;
  subscribe: (listener: () => void) => () => void;
  send: (intent: TuiIntent) => void;
  stop: () => void;
}

type LoadOutcome =
  | { ok: true; name: 'home'; reading: NeedsReading }
  | { ok: true; name: 'tree'; tree: ProjectTree }
  | { ok: false; message: string };

const initialSnapshot: TuiSnapshot = {
  view: 'home',
  views: { home: { ...emptyView, requested: true }, tree: emptyView },
  notice: '',
  messages: [],
  overlay: { kind: 'none' },
  detailOpen: false,
  fileErrors: [],
  needs: [],
  projectTree: undefined,
  folds: noFolds,
  detail: noDetail,
};

const messageLimit = 100;

const errorKeyOf = (error: TicketFileError): string => JSON.stringify([error.path, error.message]);

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const withView = (snapshot: TuiSnapshot, name: ViewName, view: ListView): TuiSnapshot => ({
  ...snapshot,
  views: { ...snapshot.views, [name]: view },
});

const withRows = (
  snapshot: TuiSnapshot,
  name: ViewName,
  rows: ListRow[],
  problems: readonly string[],
): TuiSnapshot => withView(snapshot, name, listWithRows(snapshot.views[name], rows, problems));

const withoutFailure = (snapshot: TuiSnapshot, name: ViewName): TuiSnapshot =>
  withView(snapshot, name, { ...snapshot.views[name], failure: undefined });

const withTreeRows = (snapshot: TuiSnapshot): TuiSnapshot => {
  const { projectTree, folds, needs } = snapshot;

  if (projectTree === undefined) {
    return snapshot;
  }

  return withRows(snapshot, 'tree', projectRowsOf(projectTree, folds, needs), []);
};

const applyLoad = (snapshot: TuiSnapshot, name: ViewName, outcome: LoadOutcome): TuiSnapshot => {
  if (!outcome.ok) {
    return withView(snapshot, name, { ...snapshot.views[name], failure: outcome.message });
  }

  if (outcome.name === 'tree') {
    const folds = foldsAfterLoad(snapshot.folds, outcome.tree);

    return withTreeRows({ ...withoutFailure(snapshot, 'tree'), projectTree: outcome.tree, folds });
  }

  const { items, reconcileProblems } = outcome.reading;
  const problems = reconcileProblems.map((problem) => problem.message);
  const loaded = { ...withoutFailure(snapshot, 'home'), needs: items };
  const next = withRows(loaded, 'home', homeRowsOf(items), problems);

  return withTreeRows(next);
};

const fold = (snapshot: TuiSnapshot, intent: FoldIntent): TuiSnapshot => {
  const view = snapshot.views[snapshot.view];
  const folds = foldsAfter(snapshot.folds, intent, view.rows[view.selection.index]);

  return folds === snapshot.folds ? snapshot : withTreeRows({ ...snapshot, folds });
};

const selectRow = (snapshot: TuiSnapshot, target: number): TuiSnapshot => {
  const view = snapshot.views[snapshot.view];
  const next = listAt(view, target);

  return next === view ? snapshot : withView(snapshot, snapshot.view, next);
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

const detailIntentKinds = new Set<TuiIntent['kind']>([
  'previousTab',
  'nextTab',
  'toggleAttention',
  'scrollDetail',
]);

const isDetailIntent = (intent: TuiIntent): intent is DetailIntent =>
  detailIntentKinds.has(intent.kind);

const selectedTicketOf = (snapshot: TuiSnapshot): string | undefined => {
  const { id } = snapshot.views[snapshot.view].selection;

  return typeof id === 'string' ? id : undefined;
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

  if (intent.kind === 'fold') {
    return fold(snapshot, intent.fold);
  }

  if (intent.kind === 'openDetail' || intent.kind === 'closeDetail') {
    return { ...snapshot, detailOpen: intent.kind === 'openDetail' };
  }

  if (isDetailIntent(intent)) {
    return { ...snapshot, detail: detailAfter(snapshot.detail, intent) };
  }

  return { ...snapshot, overlay: overlayAfter(snapshot.overlay, intent) };
};

const switchView = (snapshot: TuiSnapshot): TuiSnapshot => {
  const name: ViewName = snapshot.view === 'home' ? 'tree' : 'home';
  const target = snapshot.views[name];
  const selection = followedSelection(target, snapshot.views[snapshot.view].selection.id);

  return { ...withView(snapshot, name, { ...target, requested: true, selection }), view: name };
};

const homeOutcome = (result: Result<NeedsReading, CliFailure>): LoadOutcome =>
  result.ok
    ? { ok: true, name: 'home', reading: result.value }
    : { ok: false, message: result.reason.message };

const treeOutcome = (result: Result<ProjectTree, CliFailure>): LoadOutcome =>
  result.ok
    ? { ok: true, name: 'tree', tree: result.value }
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

const readFileErrors = async (effects: TuiEffects): Promise<TicketFileError[] | undefined> => {
  try {
    const loaded = await effects.loadErrors();

    return loaded.ok ? loaded.value : undefined;
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

  const publish = (next: TuiSnapshot) => {
    snapshot = next;

    for (const listener of listeners) {
      listener();
    }
  };

  const detailLoader = createDetailLoader(effects.loadDetail, (id, outcome) => {
    publish({ ...snapshot, detail: detailAfterLoad(snapshot.detail, id, outcome) });
  });

  const update = (next: TuiSnapshot) => {
    if (stopped || next === snapshot) {
      return;
    }

    const id = selectedTicketOf(next);

    if (id === next.detail.id) {
      publish(next);

      return;
    }

    publish({ ...next, detail: detailAfterSelect(next.detail, id) });

    if (id !== undefined) {
      detailLoader.request(id);
    }
  };

  const reloadDetail = () => {
    const { id } = snapshot.detail;

    if (!stopped && id !== undefined) {
      publish({ ...snapshot, detail: detailAfterReload(snapshot.detail) });
      detailLoader.request(id);
    }
  };

  const enqueue = (action: () => Promise<void>) => {
    const running = queue.then(() => (stopped ? undefined : action()));

    queue = running.catch(() => undefined);
  };

  const reportedErrors = new Set<string>();

  const messagesWith = (current: readonly TuiMessage[], texts: readonly string[]): TuiMessage[] => {
    const added = texts.map((text) => {
      lastMessageId += 1;

      return { id: lastMessageId, text };
    });

    return [...added.toReversed(), ...current].slice(0, messageLimit);
  };

  const withFileErrors = (
    next: TuiSnapshot,
    fileErrors: readonly TicketFileError[],
  ): TuiSnapshot => {
    const rows = [...next.views.home.rows, ...next.views.tree.rows];

    const strays = strayErrorsOf(fileErrors, rows).filter(
      (error) => !reportedErrors.has(errorKeyOf(error)),
    );

    for (const error of strays) {
      reportedErrors.add(errorKeyOf(error));
    }

    const texts = strays.map((error) => `${error.path}: ${error.message}`);

    return { ...next, fileErrors, messages: messagesWith(next.messages, texts) };
  };

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
      const shownId = snapshot.detail.id;

      update(publishesErrors ? withFileErrors(next, fileErrors) : next);

      if (snapshot.detail.id === shownId) {
        reloadDetail();
      }
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

    update({ ...snapshot, notice, messages: messagesWith(snapshot.messages, [notice]) });
  };

  const editSelected = (edit: (rawId: string) => Promise<Result<undefined, CliFailure>>) => {
    const { id } = snapshot.views[snapshot.view].selection;

    if (typeof id !== 'string') {
      return;
    }

    effects
      .lend(() => edit(id))
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
      editSelected((rawId) => effects.edit(rawId));
    } else if (intent.kind === 'editDesign') {
      editSelected((rawId) => effects.editDesign(rawId));
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
    detailLoader.stop();
    stopChanges();
  };

  snapshot = { ...snapshot, messages: messagesWith(snapshot.messages, effects.notices) };

  reload();

  return { getSnapshot: () => snapshot, subscribe, send, stop };
};
