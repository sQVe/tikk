import { expect, it } from 'bun:test';

import { failureOf, makeFact, successOf } from './cliHarness.ts';
import {
  claimBy,
  submittedBy,
  run,
  noSideEffects,
  sideEffectsOf,
  openFlow,
  submissionItem,
} from './instructionHarness.ts';
import type { Command } from './instructionHarness.ts';
import { instructionPassUp, instructionReject } from './instructionItem.ts';
import { instructionAccept } from './instructionSubmit.ts';
import { ticketCancel } from './ticketCancel.ts';
import { ticketShow } from './ticketShow.ts';

const question = (item: string) => makeFact({ kind: 'log', type: 'question', text: 'Why?', item });

const answer = (item: string) => makeFact({ kind: 'log', type: 'answer', text: 'So.', item });

it('reopens a rejected submission and shows the reason until the next submission', async () => {
  const flow = openFlow({ facts: [claimBy('agent'), submittedBy('agent')] });
  const rejected = await flow.step(instructionReject, ['demo-3467', '--reason', 'Tests fail.']);

  expect(successOf(rejected).json).toMatchObject({ state: 'open', claim: null });

  expect(flow.fakeSession.appends.map(({ fact }) => fact)).toMatchObject([
    { kind: 'reject', item: submissionItem, reason: 'Tests fail.' },
  ]);

  expect(successOf(await flow.step(ticketShow, ['demo-3467'])).json).toMatchObject({
    state: 'open',
    rejection: { item: submissionItem, reason: 'Tests fail.', at: '2026-10-20T12:00:00.000Z' },
  });
});

it('refuses to reject an instruction that is not submitted and writes nothing', async () => {
  for (const facts of [[], [claimBy('agent')]]) {
    const { fakeSession, result } = await run(
      instructionReject,
      ['demo-3467', '--reason', 'Tests fail.'],
      { facts },
    );

    expect(failureOf(result).code).toBe('conflict');
    expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
  }
});

it('refuses to accept or reject a submission that was already rejected and writes nothing', async () => {
  const rejected = makeFact({ kind: 'reject', item: submissionItem, reason: 'Tests fail.' });
  const facts = [claimBy('agent'), submittedBy('agent'), rejected];

  const commands: [Command, string[]][] = [
    [instructionAccept, ['demo-3467']],
    [instructionReject, ['demo-3467', '--reason', 'Still failing.']],
  ];

  for (const [command, args] of commands) {
    const { fakeSession, result } = await run(command, args, { facts });

    expect(failureOf(result).code).toBe('conflict');
    expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
  }
});

it('refuses a reject without a reason and writes nothing', async () => {
  const { fakeSession, result } = await run(instructionReject, ['demo-3467'], {
    facts: [claimBy('agent'), submittedBy('agent')],
  });

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});

it('passes up an open question', async () => {
  const { fakeSession, result } = await run(
    instructionPassUp,
    ['demo-3467', '--item', '0000000000a1'],
    { facts: [question('0000000000a1')] },
  );

  successOf(result);

  expect(fakeSession.appends.map(({ fact }) => fact)).toMatchObject([
    { kind: 'passUp', item: '0000000000a1' },
  ]);
});

it('refuses to pass up an unknown, answered, passed-up, or old submission item', async () => {
  const passedUp = makeFact({ kind: 'passUp', item: '0000000000a1' });
  const older = makeFact({ kind: 'log', type: 'submitted', text: '', item: '0000000000b1' });

  const cases = [
    { item: '0000000000c1', facts: [question('0000000000a1')] },
    { item: '0000000000a1', facts: [question('0000000000a1'), answer('0000000000a1')] },
    { item: '0000000000a1', facts: [question('0000000000a1'), passedUp] },
    { item: '0000000000b1', facts: [older, claimBy('agent'), submittedBy('agent')] },
  ];

  for (const { item, facts } of cases) {
    const { fakeSession, result } = await run(instructionPassUp, ['demo-3467', '--item', item], {
      facts,
    });

    expect(failureOf(result).code).toBe('conflict');
    expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
  }
});

it('refuses a pass-up without an item and writes nothing', async () => {
  const { fakeSession, result } = await run(instructionPassUp, ['demo-3467'], {
    facts: [question('0000000000a1')],
  });

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});

it('keeps the latest rejection in the output of cancel and of a later show', async () => {
  const flow = openFlow({ facts: [claimBy('agent'), submittedBy('agent')] });

  successOf(await flow.step(instructionReject, ['demo-3467', '--reason', 'Tests fail.']));

  const rejection = { item: submissionItem, reason: 'Tests fail.' };
  const canceled = await flow.step(ticketCancel, ['demo-3467']);

  expect(successOf(canceled).json).toMatchObject({ state: 'canceled', rejection });

  expect(successOf(await flow.step(ticketShow, ['demo-3467'])).json).toMatchObject({
    state: 'canceled',
    rejection,
  });
});
