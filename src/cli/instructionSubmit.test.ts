import { expect, it } from 'bun:test';

import { failureOf, makeTicket, successOf } from './cliHarness.ts';
import { instructionClaim, instructionRelease } from './instructionClaim.ts';
import {
  claimBy,
  submittedBy,
  run,
  noSideEffects,
  sideEffectsOf,
  orphan,
  parentOnly,
  parentSlice,
  blockedOnly,
  submissionItem,
  itemOf,
} from './instructionHarness.ts';
import type { Command } from './instructionHarness.ts';
import { instructionAccept, instructionSubmit } from './instructionSubmit.ts';

it('submits an instruction held by the same holder', async () => {
  const { fakeSession, result } = await run(
    instructionSubmit,
    ['demo-3467', '--holder', 'agent', '--text', 'Ready for review'],
    { facts: [claimBy('agent')] },
  );

  const item = itemOf(result);

  expect(successOf(result).json).toMatchObject({ state: 'submitted' });
  expect(item).toMatch(/^[0-9a-f]{12}$/);

  expect(fakeSession.appends.map(({ fact }) => fact)).toMatchObject([
    {
      kind: 'log',
      type: 'submitted',
      text: 'Ready for review',
      holder: 'agent',
      item,
    },
  ]);
});

it('refuses a submit by another holder and writes nothing', async () => {
  const { fakeSession, result } = await run(instructionSubmit, ['demo-3467', '--holder', 'agent'], {
    facts: [claimBy('other')],
  });

  expect(failureOf(result).code).toBe('conflict');
  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});

it('accepts a submitted instruction', async () => {
  const { fakeSession, result } = await run(instructionAccept, ['demo-3467'], {
    facts: [claimBy('agent'), submittedBy('agent')],
  });

  expect(successOf(result).json).toMatchObject({ state: 'done' });

  expect(fakeSession.appends.map(({ fact }) => fact)).toMatchObject([
    { kind: 'accept', item: submissionItem },
  ]);
});

it('refuses to accept an instruction that is not submitted and writes nothing', async () => {
  for (const facts of [[], [claimBy('agent')]]) {
    const { fakeSession, result } = await run(instructionAccept, ['demo-3467'], { facts });

    expect(failureOf(result).code).toBe('conflict');
    expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
  }
});

it('refuses claim, release, submit, and accept on an instruction whose file has an error', async () => {
  const broken = makeTicket('demo-3467', { error: 'Bad YAML.' });

  const commands: [Command, string[]][] = [
    [instructionClaim, ['demo-3467', '--holder', 'agent']],
    [instructionRelease, ['demo-3467', '--holder', 'agent']],
    [instructionSubmit, ['demo-3467', '--holder', 'agent']],
    [instructionAccept, ['demo-3467']],
  ];

  for (const [command, args] of commands) {
    const { fakeSession, result } = await run(command, args, {
      tickets: [broken],
      facts: [claimBy('agent'), submittedBy('agent')],
    });

    expect(failureOf(result).code).toBe('parseError');
    expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
  }
});

it('refuses to submit an instruction whose parent does not exist and appends nothing', async () => {
  const { fakeSession, result } = await run(instructionSubmit, ['demo-3467', '--holder', 'agent'], {
    tickets: [parentOnly()],
    facts: [claimBy('agent')],
  });

  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('demo-4789');
  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});

it('refuses to submit an instruction blocked by a ticket that does not exist and appends nothing', async () => {
  const { fakeSession, result } = await run(instructionSubmit, ['demo-3467', '--holder', 'agent'], {
    tickets: [parentSlice, blockedOnly()],
    facts: [claimBy('agent')],
  });

  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('demo-6789');
  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});

it('submits past a failed tree check with --force --reason and records the reason', async () => {
  const { fakeSession, result } = await run(
    instructionSubmit,
    ['demo-3467', '--holder', 'agent', '--force', '--reason', 'Blocker was deleted'],
    { tickets: [orphan()], facts: [claimBy('agent')] },
  );

  successOf(result);
  expect(fakeSession.appends).toHaveLength(1);

  expect(fakeSession.appends[0]?.fact).toMatchObject({
    kind: 'log',
    type: 'submitted',
    forced: 'Blocker was deleted',
  });
});

it('refuses --force without --reason on a sound tree and changes nothing', async () => {
  const { fakeSession, result } = await run(
    instructionSubmit,
    ['demo-3467', '--holder', 'agent', '--force'],
    { facts: [claimBy('agent')] },
  );

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});

it('refuses --force with an empty --reason and changes nothing', async () => {
  const { fakeSession, result } = await run(
    instructionSubmit,
    ['demo-3467', '--holder', 'agent', '--force', '--reason', ''],
    { tickets: [orphan()], facts: [claimBy('agent')] },
  );

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});
