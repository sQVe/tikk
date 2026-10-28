import type { CliFailure, TicketDetail } from '../cli/cli.ts';
import type { Result } from '../result.ts';
import { topAfter } from './overlayScroll.ts';
import type { OverlayMove } from './overlayScroll.ts';

export type DetailTab = 'overview' | 'criteria' | 'activity' | 'links';

export type LoadDetail = (rawId: string) => Promise<Result<TicketDetail, CliFailure>>;

export type DetailLoad =
  | { status: 'loading'; detail: TicketDetail | undefined }
  | { status: 'loaded'; detail: TicketDetail }
  | { status: 'failed'; message: string };

export interface DetailState {
  id: string | undefined;
  load: DetailLoad;
  tab: DetailTab;
  attentionExpanded: boolean;
  top: number;
}

export type DetailIntent =
  | { kind: 'previousTab' }
  | { kind: 'nextTab' }
  | { kind: 'toggleAttention' }
  | { kind: 'scrollDetail'; move: OverlayMove; maximumTop: number };

export interface DetailStep {
  unit: 'line' | 'halfPage';
  direction: 1 | -1;
}

type DetailOutcome = Result<TicketDetail, string>;

const allTabs: readonly DetailTab[] = ['overview', 'criteria', 'activity', 'links'];

export const noDetail: DetailState = {
  id: undefined,
  load: { status: 'loading', detail: undefined },
  tab: 'overview',
  attentionExpanded: false,
  top: 0,
};

export const detailOf = (load: DetailLoad): TicketDetail | undefined =>
  load.status === 'failed' ? undefined : load.detail;

export const tabsOf = (detail: TicketDetail | undefined): DetailTab[] =>
  detail?.ticket.kind === 'instruction'
    ? allTabs.filter((tab) => tab !== 'criteria')
    : [...allTabs];

export const detailAfterSelect = (state: DetailState, id: string | undefined): DetailState => {
  if (id === state.id) {
    return state;
  }

  return {
    ...state,
    id,
    load: { status: 'loading', detail: undefined },
    attentionExpanded: false,
    top: 0,
  };
};

export const detailAfterReload = (state: DetailState): DetailState => ({
  ...state,
  load: { status: 'loading', detail: detailOf(state.load) },
});

export const detailAfterLoad = (
  state: DetailState,
  id: string,
  outcome: DetailOutcome,
): DetailState => {
  if (id !== state.id) {
    return state;
  }

  if (!outcome.ok) {
    return { ...state, load: { status: 'failed', message: outcome.reason } };
  }

  const detail = outcome.value;
  const tab = tabsOf(detail).includes(state.tab) ? state.tab : 'overview';

  return { ...state, load: { status: 'loaded', detail }, tab };
};

const tabAfter = (state: DetailState, step: number): DetailState => {
  const tabs = tabsOf(detailOf(state.load));
  const index = Math.max(0, tabs.indexOf(state.tab));
  const tab = tabs[(index + step + tabs.length) % tabs.length] ?? 'overview';

  return { ...state, tab, top: 0 };
};

export const detailAfter = (state: DetailState, intent: DetailIntent): DetailState => {
  if (intent.kind === 'previousTab') {
    return tabAfter(state, -1);
  }

  if (intent.kind === 'nextTab') {
    return tabAfter(state, 1);
  }

  if (intent.kind === 'toggleAttention') {
    return { ...state, attentionExpanded: !state.attentionExpanded };
  }

  return { ...state, top: topAfter(state.top, intent.move, intent.maximumTop) };
};

const readDetail = async (load: LoadDetail, id: string): Promise<DetailOutcome> => {
  try {
    const result = await load(id);

    return result.ok ? result : { ok: false, reason: result.reason.message };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'The ticket did not load.',
    };
  }
};

// Publishes only the newest request, and nothing after stop.
export const createDetailLoader = (
  load: LoadDetail,
  publish: (id: string, outcome: DetailOutcome) => void,
): { request: (id: string) => void; stop: () => void } => {
  let latest = 0;
  let stopped = false;

  const request = (id: string) => {
    latest += 1;

    const current = latest;

    readDetail(load, id)
      .then((outcome) => {
        if (!stopped && current === latest) {
          publish(id, outcome);
        }
      })
      .catch(() => undefined);
  };

  const stop = () => {
    stopped = true;
  };

  return { request, stop };
};
