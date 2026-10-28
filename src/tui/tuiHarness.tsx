import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { useRenderer } from '@opentui/react';
import { testRender } from '@opentui/react/test-utils';
import { act, useLayoutEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { NeedView, ProjectTree, TicketDetail, TreeProject } from '../cli/cli.ts';
import { invariant } from '../invariant.ts';
import { App, catalog, createTuiSession, defaultBindings } from './tui.tsx';
import type { AppProps, BindingTable, IconChoice, TuiEffects } from './tui.tsx';

type Setup = Awaited<ReturnType<typeof testRender>>;

interface CommitProbeControls {
  setup: Setup | undefined;
  keysAtCommit: string[];
  reloaded: () => void;
}

export interface TuiFixture {
  setup: Setup;
  edited: string[];
  designEdited: string[];
  quits: () => number;
  press: (key: string, modifiers?: { ctrl: boolean }) => Promise<void>;
  storeChanged: () => Promise<void>;
  selectedLine: () => string | undefined;
  pressAtNextCommit: (...keys: string[]) => void;
  cleanup: () => void;
}

type DetailKind = TicketDetail['ticket']['kind'];

interface DetailEntry {
  kind: DetailKind;
  title: string;
  state: TicketDetail['state'];
  parent: string | null;
}

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const firstDemoNumber = 3400;
const mountSettleMilliseconds = 30;
const keySettleMilliseconds = 20;

// Renders after the app, so its layout effect runs after the app's commit and before any passive
// effect of that commit.
const CommitProbe = ({ probe }: { probe: CommitProbeControls }): ReactNode => {
  const [reloads, setReloads] = useState(0);

  probe.reloaded = () => {
    setReloads((current) => current + 1);
  };

  useLayoutEffect(() => {
    for (const key of probe.keysAtCommit.splice(0)) {
      probe.setup?.mockInput.pressKey(key);
    }
  }, [reloads, probe]);

  return null;
};

const WithKeymap = ({
  probe,
  ...props
}: Omit<AppProps, 'keymap'> & { probe: CommitProbeControls }): ReactNode => {
  const renderer = useRenderer();
  const keymap = useMemo(() => createDefaultOpenTuiKeymap(renderer), [renderer]);

  return (
    <>
      <App {...props} keymap={keymap} />
      <CommitProbe probe={probe} />
    </>
  );
};

const isDemoId = (raw: string): raw is NeedView['id'] => /^demo-\d+$/.test(raw);

export const ticketId = (raw: string): NeedView['id'] => {
  invariant(isDemoId(raw), `Test ID ${raw} is invalid.`);

  return raw;
};

const isProjectName = (raw: string): raw is TreeProject['name'] => /^[a-z][a-z0-9-]*$/.test(raw);

export const projectName = (raw: string): TreeProject['name'] => {
  invariant(isProjectName(raw), `Test project ${raw} is invalid.`);

  return raw;
};

// The label of a command as the catalog defines it, so tests track rewording of the label.
export const commandLabel = (id: string): string => {
  const command = catalog.find((candidate) => candidate.id === id);

  invariant(command !== undefined, `The catalog has no ${id} command.`);

  return command.label;
};

export const needView = (index: number, title: string): NeedView => ({
  id: ticketId(`demo-${firstDemoNumber + index}`),
  title,
  reason: 'submitted',
  since: '2026-10-20T11:00:00.000Z',
  ageSeconds: 60,
  item: 'abc123def456',
  passedUp: true,
});

export const noProjects = (): ProjectTree => ({ current: null, projects: [] });

// One current project with a plan, an active slice with a PR, and one instruction.
export const projectTree = (): ProjectTree => ({
  current: projectName('demo'),
  projects: [
    {
      name: projectName('demo'),
      inbox: [],
      plans: [
        {
          id: ticketId('demo-3401'),
          title: 'Plan title',
          state: 'open',
          tasks: [],
          slices: [
            {
              id: ticketId('demo-3402'),
              title: 'Slice title',
              state: 'active',
              pr: 12,
              tasks: [],
              instructions: [
                { id: ticketId('demo-3403'), title: 'Instruction title', state: 'open' },
              ],
            },
          ],
        },
      ],
      slices: [],
    },
  ],
});

export const ticketDetail = (
  id: string,
  entry: DetailEntry,
  overrides: Partial<Omit<TicketDetail, 'ticket'>> & {
    ticket?: Partial<TicketDetail['ticket']>;
  } = {},
): TicketDetail => {
  const { ticket, ...rest } = overrides;

  return {
    ticket: {
      id,
      path: `/s/${id}.md`,
      hash: `hash-${id}`,
      kind: entry.kind,
      title: entry.title,
      project: 'demo',
      parent: entry.parent,
      rank: null,
      blockedBy: [],
      discoveredFrom: [],
      related: [],
      criteria: null,
      covers: null,
      status: 'open',
      archived: null,
      error: null,
      ...ticket,
    },
    body: '',
    state: entry.state,
    pr: null,
    children: [],
    facts: [],
    ...rest,
  };
};

const prOf = (number: number): TicketDetail['pr'] => ({
  repository: 'acme/app',
  number,
  state: 'open',
  base: 'main',
  head: 'head1',
  mergeCommit: null,
  inTrunk: false,
  checkedAt: '2026-10-20T11:00:00.000Z',
});

const treeDetailsOf = (tree: ProjectTree): Map<string, TicketDetail> => {
  const entries = new Map<string, TicketDetail>();

  const add = (
    kind: DetailKind,
    parent: string | null,
    ticket: { id: string; title: string; state: DetailEntry['state'] },
  ) => {
    entries.set(
      ticket.id,
      ticketDetail(ticket.id, { kind, title: ticket.title, state: ticket.state, parent }),
    );
  };

  const addSlice = (slice: TreeProject['slices'][number], parent: string | null) => {
    entries.set(
      slice.id,
      ticketDetail(
        slice.id,
        { kind: 'slice', title: slice.title, state: slice.state, parent },
        { pr: slice.pr === null ? null : prOf(slice.pr) },
      ),
    );

    for (const task of slice.tasks) {
      add('task', slice.id, task);
    }

    for (const instruction of slice.instructions) {
      add('instruction', slice.id, instruction);
    }
  };

  for (const project of tree.projects) {
    for (const task of project.inbox) {
      add('task', null, task);
    }

    for (const plan of project.plans) {
      add('plan', null, plan);

      for (const task of plan.tasks) {
        add('task', plan.id, task);
      }

      for (const slice of plan.slices) {
        addSlice(slice, plan.id);
      }
    }

    for (const slice of project.slices) {
      addSlice(slice, null);
    }
  }

  return entries;
};

// Reads the detail of a ticket from the tree, or of a home item as an open instruction.
const demoLoadDetail =
  (items: readonly NeedView[], tree: ProjectTree): TuiEffects['loadDetail'] =>
  (rawId) => {
    const item = items.find((candidate) => candidate.id === rawId);

    const itemDetail =
      item === undefined
        ? undefined
        : ticketDetail(rawId, {
            kind: 'instruction',
            title: item.title,
            state: 'open',
            parent: null,
          });

    const detail = treeDetailsOf(tree).get(rawId) ?? itemDetail;

    if (detail === undefined) {
      return Promise.resolve({
        ok: false,
        reason: { code: 'notFound', message: `Ticket ${rawId} does not exist.` },
      });
    }

    return Promise.resolve({ ok: true, value: detail });
  };

export const createTuiFixture = async (
  items: NeedView[],
  size: { width: number; height: number },
  problems: string[] = [],
  tree: ProjectTree = noProjects(),
  overrides: Partial<TuiEffects> = {},
  bindings: BindingTable = defaultBindings,
  notices: string[] = [],
  icons: IconChoice = 'unicode',
): Promise<TuiFixture> => {
  const changeListeners = new Set<() => void>();
  const edited: string[] = [];
  const designEdited: string[] = [];
  let quitCount = 0;

  const probe: CommitProbeControls = {
    setup: undefined,
    keysAtCommit: [],
    reloaded: () => undefined,
  };

  const reconcileProblems = problems.map((message) => ({
    ticket: null,
    repository: null,
    number: null,
    message,
  }));

  const effects: TuiEffects = {
    load: () => {
      const loaded = Promise.resolve({
        ok: true as const,
        value: { items: [...items], reconcileProblems },
      });

      return loaded.then((result) => {
        probe.reloaded();

        return result;
      });
    },
    loadTree: () => {
      const loaded = Promise.resolve({ ok: true as const, value: structuredClone(tree) });

      return loaded.then((result) => {
        probe.reloaded();

        return result;
      });
    },
    loadErrors: () => Promise.resolve({ ok: true, value: [] }),
    loadDetail: demoLoadDetail(items, tree),
    edit: (rawId) => {
      edited.push(rawId);

      return Promise.resolve({ ok: true, value: undefined });
    },
    editDesign: (rawId) => {
      designEdited.push(rawId);

      return Promise.resolve({ ok: true, value: undefined });
    },
    lend: async (run) => ({ ok: true, value: await run() }),
    onChange: (listener) => {
      changeListeners.add(listener);

      return () => changeListeners.delete(listener);
    },
    notices,
    ...overrides,
  };

  const session = createTuiSession(effects);

  const setup = await act(() =>
    testRender(
      <WithKeymap
        session={session}
        bindings={bindings}
        icons={icons}
        onQuit={() => {
          quitCount += 1;
        }}
        probe={probe}
      />,
      size,
    ),
  );

  probe.setup = setup;

  const cleanup = (): void => {
    session.stop();
    changeListeners.clear();
    probe.keysAtCommit.splice(0);

    act(() => {
      setup.renderer.destroy();
    });
  };

  let settled = false;

  // The caller gets no fixture to clean up when settling fails, so the renderer is destroyed here.
  try {
    await act(async () => {
      await Bun.sleep(mountSettleMilliseconds);
      await setup.renderOnce();
    });

    settled = true;
  } finally {
    if (!settled) {
      cleanup();
    }
  }

  const press = async (key: string, modifiers?: { ctrl: boolean }): Promise<void> => {
    await act(async () => {
      if (key === 'up' || key === 'down') {
        setup.mockInput.pressArrow(key);
      } else {
        setup.mockInput.pressKey(key, modifiers);
      }

      await Bun.sleep(keySettleMilliseconds);
      await setup.renderOnce();
    });

    await act(async () => {
      await setup.renderOnce();
    });
  };

  const storeChanged = async (): Promise<void> => {
    await act(async () => {
      for (const listener of changeListeners) {
        listener();
      }

      await Bun.sleep(keySettleMilliseconds);
      await setup.renderOnce();
    });

    await act(async () => {
      await setup.renderOnce();
    });
  };

  const selectedLine = (): string | undefined =>
    setup
      .captureCharFrame()
      .split('\n')
      .find((line) => line.startsWith('>'));

  const pressAtNextCommit = (...keys: string[]): void => {
    probe.keysAtCommit.push(...keys);
  };

  return {
    setup,
    edited,
    designEdited,
    quits: () => quitCount,
    press,
    storeChanged,
    selectedLine,
    pressAtNextCommit,
    cleanup,
  };
};
