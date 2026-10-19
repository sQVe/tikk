import { expect, it } from 'bun:test';

import { parseTicketFile, serializeTicketFile } from './ticket.ts';

const taskText = `---
kind: task
title: Fix the parser
project: tikk
status: open
---
Body line one.

Body line two.
`;

it('parses a task file and returns the same values after a round trip', () => {
  const parsed = parseTicketFile(taskText);

  expect(parsed.ok).toBe(true);

  if (!parsed.ok) {
    return;
  }

  expect(parsed.value.frontMatter.title).toBe('Fix the parser');
  expect(parsed.value.body).toBe('Body line one.\n\nBody line two.\n');

  const again = parseTicketFile(serializeTicketFile(parsed.value));

  expect(again).toEqual(parsed);
});

it('round trips every optional field', () => {
  const text = `---
kind: issue
title: "Colon: in title"
project: my-project
parent: my-project-ab3d
rank: 2.5
blockedBy:
  - my-project-cd4e
status: closed
archived: 2026-10-18
---
`;

  const parsed = parseTicketFile(text);

  expect(parsed.ok).toBe(true);

  if (!parsed.ok) {
    return;
  }

  expect(parsed.value.body).toBe('');
  expect(parseTicketFile(serializeTicketFile(parsed.value))).toEqual(parsed);
});

it('defaults blockedBy to an empty list', () => {
  const parsed = parseTicketFile(taskText);

  expect(parsed.ok && parsed.value.frontMatter.blockedBy).toEqual([]);
});

const failures: [string, string][] = [
  ['a missing --- block', '# Just a heading\n'],
  ['invalid YAML', '---\nkind: [task\n---\nBody\n'],
  ['an unknown key', taskText.replace('status: open', 'status: open\nrelated: []')],
  ['status closed on a task', taskText.replace('status: open', 'status: closed')],
  ['an empty title', taskText.replace('Fix the parser', '""')],
  ['a bad parent ID', taskText.replace('status: open', 'status: open\nparent: tikk-l0l0')],
  ['an unsupported kind', taskText.replace('kind: task', 'kind: plan')],
];

it.each(failures)('returns a failure with a message for %s', (_name, text) => {
  const parsed = parseTicketFile(text);

  expect(parsed.ok).toBe(false);
  expect(!parsed.ok && parsed.reason.message.length > 0).toBe(true);
});
