import { expect, it } from 'bun:test';

import type { CliFailure, NeedView, TicketDetail } from '../cli/cli.ts';
import type { Result } from '../result.ts';
import { needView, ticketDetail } from './tuiHarness.tsx';
import { createTuiSession } from './tuiSession.ts';
import type { TuiSession } from './tuiSession.ts';

type DetailResult = Result<TicketDetail, CliFailure>;

interface DetailCall {
  id: string;
  resolve: (result: DetailResult) => void;
}

interface FakeDetails {
  session: TuiSession;
  calls: DetailCall[];
  storeChanged: () => Promise<void>;
}

const settle = (): Promise<void> => Bun.sleep(5);

const sliceDetail = (id: string): TicketDetail =>
  ticketDetail(id, { kind: 'slice', title: `Slice ${id}`, state: 'active', parent: null });

const instructionDetail = (id: string): TicketDetail =>
  ticketDetail(id, {
    kind: 'instruction',
    title: `Instruction ${id}`,
    state: 'open',
    parent: null,
  });

// Each detail load waits until the test resolves it, unless details answers it at once.
const createFake = async (
  items: NeedView[],
  details: ReadonlyMap<string, TicketDetail> = new Map(),
): Promise<FakeDetails> => {
  const calls: DetailCall[] = [];
  const changeListeners = new Set<() => void>();

  const session = createTuiSession({
    load: async () => ({ ok: true, value: { items: [...items], reconcileProblems: [] } }),
    loadTree: async () => ({ ok: true, value: { current: null, projects: [] } }),
    loadErrors: async () => ({ ok: true, value: [] }),
    loadDetail: (rawId) => {
      const known = details.get(rawId);

      if (known !== undefined) {
        return Promise.resolve({ ok: true, value: known });
      }

      const gate = Promise.withResolvers<DetailResult>();

      calls.push({ id: rawId, resolve: gate.resolve });

      return gate.promise;
    },
    edit: async () => ({ ok: true, value: undefined }),
    lend: async (run) => ({ ok: true, value: await run() }),
    onChange: (listener) => {
      changeListeners.add(listener);

      return () => {
        changeListeners.delete(listener);
      };
    },
    notices: [],
  });

  await settle();

  const storeChanged = async () => {
    for (const listener of changeListeners) {
      listener();
    }

    await settle();
  };

  return { session, calls, storeChanged };
};

const twoSlices = new Map([
  ['demo-3400', sliceDetail('demo-3400')],
  ['demo-3401', sliceDetail('demo-3401')],
]);

const viewOn = (session: TuiSession) => {
  const { detail } = session.getSnapshot();

  return {
    id: detail.id,
    tab: detail.tab,
    expanded: detail.attentionExpanded,
    top: detail.top,
    status: detail.load.status,
  };
};

const changeView = async (session: TuiSession): Promise<void> => {
  session.send({ kind: 'nextTab' });
  session.send({ kind: 'toggleAttention' });
  session.send({ kind: 'scrollDetail', move: { kind: 'lines', lines: 3 }, maximumTop: 10 });
  await settle();
};

it('keeps the tab, the expanded attention, and the scroll top when the same ticket reloads', async () => {
  const fake = await createFake([needView(0, 'First')], twoSlices);

  await changeView(fake.session);
  await fake.storeChanged();

  expect(viewOn(fake.session)).toEqual({
    id: 'demo-3400',
    tab: 'criteria',
    expanded: true,
    top: 3,
    status: 'loaded',
  });
});

it('keeps the tab and resets the attention and scroll top on another ticket', async () => {
  const fake = await createFake([needView(0, 'First'), needView(1, 'Second')], twoSlices);

  await changeView(fake.session);
  fake.session.send({ kind: 'moveDown' });
  await settle();

  expect(viewOn(fake.session)).toEqual({
    id: 'demo-3401',
    tab: 'criteria',
    expanded: false,
    top: 0,
    status: 'loaded',
  });
});

it('falls back to Overview when the next ticket hides the tab', async () => {
  const details = new Map([
    ['demo-3400', sliceDetail('demo-3400')],
    ['demo-3401', instructionDetail('demo-3401')],
  ]);

  const fake = await createFake([needView(0, 'First'), needView(1, 'Second')], details);

  fake.session.send({ kind: 'nextTab' });
  expect(fake.session.getSnapshot().detail.tab).toBe('criteria');

  fake.session.send({ kind: 'moveDown' });
  await settle();

  expect(viewOn(fake.session).tab).toBe('overview');

  fake.session.send({ kind: 'nextTab' });

  expect(viewOn(fake.session).tab).toBe('activity');
});

it('drops a detail load that a later selection superseded', async () => {
  const fake = await createFake([needView(0, 'First'), needView(1, 'Second')]);

  fake.session.send({ kind: 'moveDown' });
  await settle();

  const [first, second] = fake.calls;

  second?.resolve({ ok: true, value: sliceDetail('demo-3401') });
  await settle();
  first?.resolve({ ok: true, value: sliceDetail('demo-3400') });
  await settle();

  const { detail } = fake.session.getSnapshot();
  const loadedId = detail.load.status === 'loaded' ? detail.load.detail.ticket.id : undefined;

  expect(fake.calls.map((call) => call.id)).toEqual(['demo-3400', 'demo-3401']);
  expect(detail.id).toBe('demo-3401');
  expect(loadedId).toBe('demo-3401');
});

it('shows the failure of a detail load', async () => {
  const fake = await createFake([needView(0, 'First')]);

  fake.calls[0]?.resolve({ ok: false, reason: { code: 'notFound', message: 'Gone.' } });
  await settle();

  expect(fake.session.getSnapshot().detail.load).toEqual({ status: 'failed', message: 'Gone.' });
});

it('publishes no detail that settles after stop', async () => {
  const fake = await createFake([needView(0, 'First')]);
  let notified = 0;

  fake.session.subscribe(() => {
    notified += 1;
  });

  fake.session.stop();
  fake.calls[0]?.resolve({ ok: true, value: sliceDetail('demo-3400') });
  await settle();

  expect(fake.calls).toHaveLength(1);
  expect(notified).toBe(0);
  expect(fake.session.getSnapshot().detail.load.status).toBe('loading');
});
