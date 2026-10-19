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

const failures: [string, string, string][] = [
  ['a missing --- block', '# Just a heading\n', 'missingFrontMatter'],
  ['invalid YAML', '---\nkind: [task\n---\nBody\n', 'invalidYaml'],
  [
    'an unknown key',
    taskText.replace('status: open', 'status: open\nrelated: []'),
    'invalidFrontMatter',
  ],
  [
    'status closed on a task',
    taskText.replace('status: open', 'status: closed'),
    'invalidFrontMatter',
  ],
  ['an empty title', taskText.replace('Fix the parser', '""'), 'invalidFrontMatter'],
  [
    'a bad parent ID',
    taskText.replace('status: open', 'status: open\nparent: tikk-l0l0'),
    'invalidFrontMatter',
  ],
  ['an unsupported kind', taskText.replace('kind: task', 'kind: plan'), 'invalidFrontMatter'],
  ['an empty front matter block', '---\n---\n', 'invalidFrontMatter'],
];

it.each(failures)('returns a failure with a message for %s', (_name, text, kind) => {
  const parsed = parseTicketFile(text);

  expect(parsed.ok).toBe(false);
  const actualKind: string | undefined = parsed.ok ? undefined : parsed.reason.kind;

  expect(actualKind).toBe(kind);
  expect(!parsed.ok && parsed.reason.message.length > 0).toBe(true);
});

it('reads an empty body when nothing follows the closing delimiter', () => {
  const parsed = parseTicketFile(taskText.slice(0, taskText.indexOf('\n---\n') + 4));

  expect(parsed.ok && parsed.value.body).toBe('');
});

it('writes the closing delimiter on the line after the front matter', () => {
  const parsed = parseTicketFile(taskText);

  if (!parsed.ok) {
    throw new Error(parsed.reason.message);
  }

  const text = serializeTicketFile({ frontMatter: parsed.value.frontMatter, body: 'Body\n' });

  expect(text).toStartWith('---\n');
  expect(text).toEndWith('\n---\nBody\n');
  expect(text).not.toContain('\n\n---');
});

it('parses CRLF around the delimiters and keeps the body as written', () => {
  const parsed = parseTicketFile(taskText.replaceAll('\n', '\r\n'));

  expect(parsed.ok).toBe(true);
  expect(parsed.ok && parsed.value.frontMatter.title).toBe('Fix the parser');
  expect(parsed.ok && parsed.value.body).toBe('Body line one.\r\n\r\nBody line two.\r\n');
});
