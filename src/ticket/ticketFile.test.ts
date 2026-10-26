import { expect, it } from 'bun:test';

import { parseTicketFile, serializeTicketFile } from './ticket.ts';

const instructionText = `---
kind: instruction
title: Fix the parser
project: tikk
status: open
---
Body line one.

Body line two.
`;

it('parses an instruction file and returns the same values after a round trip', () => {
  const parsed = parseTicketFile(instructionText);

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
kind: task
title: "Colon: in title"
project: my-project
parent: my-project-ab3d
rank: 2.5
blockedBy:
  - my-project-cd4e
status: done
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
  const parsed = parseTicketFile(instructionText);

  expect(parsed.ok && parsed.value.frontMatter.blockedBy).toEqual([]);
});

const failures: [string, string, string][] = [
  ['a missing --- block', '# Just a heading\n', 'missingFrontMatter'],
  ['invalid YAML', '---\nkind: [instruction\n---\nBody\n', 'invalidYaml'],
  [
    'an unknown key',
    instructionText.replace('status: open', 'status: open\nbogus: []'),
    'invalidFrontMatter',
  ],
  [
    'status done on an instruction',
    instructionText.replace('status: open', 'status: done'),
    'invalidFrontMatter',
  ],
  ['an empty title', instructionText.replace('Fix the parser', '""'), 'invalidFrontMatter'],
  [
    'a bad parent ID',
    instructionText.replace('status: open', 'status: open\nparent: tikk-l0l0'),
    'invalidFrontMatter',
  ],
  [
    'an unsupported kind',
    instructionText.replace('kind: instruction', 'kind: epic'),
    'invalidFrontMatter',
  ],
  ['an empty front matter block', '---\n---\n', 'invalidFrontMatter'],
];

const taskText = `---
kind: task
title: Call the vendor
project: tikk
status: open
---
`;

const taskRefusals: [string, string][] = [
  ['a task that is a draft', taskText.replace('status: open', 'status: draft')],
  [
    'new on a task with a parent',
    taskText.replace('status: open', 'status: open\nparent: tikk-3467\nnew: true'),
  ],
  ['new on a done task', taskText.replace('status: open', 'status: done\nnew: true')],
];

it.each(taskRefusals)('refuses %s', (_name, text) => {
  expect(parseTicketFile(text).ok).toBe(false);
});

it('keeps new on a loose open task', () => {
  const parsed = parseTicketFile(taskText.replace('status: open', 'status: open\nnew: true'));

  expect(parsed.ok && parsed.value.frontMatter.new).toBe(true);
});

it.each(failures)('returns a failure with a message for %s', (_name, text, kind) => {
  const parsed = parseTicketFile(text);

  expect(parsed.ok).toBe(false);
  const actualKind: string | undefined = parsed.ok ? undefined : parsed.reason.kind;

  expect(actualKind).toBe(kind);
  expect(!parsed.ok && parsed.reason.message.length > 0).toBe(true);
});

it('reads an empty body when nothing follows the closing delimiter', () => {
  const parsed = parseTicketFile(instructionText.slice(0, instructionText.indexOf('\n---\n') + 4));

  expect(parsed.ok && parsed.value.body).toBe('');
});

it('writes the closing delimiter on the line after the front matter', () => {
  const parsed = parseTicketFile(instructionText);

  if (!parsed.ok) {
    throw new Error(parsed.reason.message);
  }

  const text = serializeTicketFile({ frontMatter: parsed.value.frontMatter, body: 'Body\n' });

  expect(text).toStartWith('---\n');
  expect(text).toEndWith('\n---\nBody\n');
  expect(text).not.toContain('\n\n---');
});

it('parses CRLF around the delimiters and keeps the body as written', () => {
  const parsed = parseTicketFile(instructionText.replaceAll('\n', '\r\n'));

  expect(parsed.ok).toBe(true);
  expect(parsed.ok && parsed.value.frontMatter.title).toBe('Fix the parser');
  expect(parsed.ok && parsed.value.body).toBe('Body line one.\r\n\r\nBody line two.\r\n');
});

const refusedFiles: [string, string][] = [
  [
    'an instruction file with criteria',
    'kind: instruction\ncriteria:\n  - id: a\n    check: c\n    expected: e',
  ],
  ['a task file with covers', 'kind: task\ncovers:\n  - a'],
  [
    'a slice file with duplicate criterion IDs',
    'kind: slice\ncriteria:\n  - id: a\n    check: c\n    expected: e\n  - id: a\n    check: c\n    expected: e',
  ],
  [
    'a plan file with an invalid criterion ID',
    'kind: plan\ncriteria:\n  - id: Bad_Id\n    check: c\n    expected: e',
  ],
];

for (const [name, lines] of refusedFiles) {
  it(`fails to parse ${name}`, () => {
    const parsed = parseTicketFile(`---\n${lines}\ntitle: T\nproject: tikk\nstatus: open\n---\n`);

    expect(parsed.ok).toBe(false);
  });
}

it('round trips criteria and covers', () => {
  const text = `---
kind: slice
title: T
project: tikk
criteria:
  - id: first-one
    check: Run it.
    expected: Ok.
covers:
  - first-one
discoveredFrom:
  - tikk-ab3d
related:
  - tikk-cd4e
status: open
---
`;

  const parsed = parseTicketFile(text);

  expect(parsed.ok).toBe(true);

  if (!parsed.ok) {
    return;
  }

  expect(parseTicketFile(serializeTicketFile(parsed.value))).toEqual(parsed);
});

it('parses a plan with two criteria that have different IDs', () => {
  const parsed = parseTicketFile(
    '---\nkind: plan\ntitle: T\nproject: tikk\nstatus: open\ncriteria:\n  - id: a\n    check: c\n    expected: e\n  - id: b\n    check: c\n    expected: e\n---\n',
  );

  expect(parsed.ok && parsed.value.frontMatter.criteria?.map((criterion) => criterion.id)).toEqual([
    'a',
    'b',
  ]);
});

it('fails to parse a slice file with new and names new', () => {
  const sliceText = `---
kind: slice
title: Slice
project: tikk
status: open
criteria:
  - id: works
    check: Run the command.
    expected: It prints ok.
new: true
---
`;

  const parsed = parseTicketFile(sliceText);

  expect(parsed.ok).toBe(false);
  expect(!parsed.ok && parsed.reason.message).toContain('new');
});
