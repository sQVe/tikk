import { expect, it } from 'bun:test';

import { parseProjectName, parseTicketFileName, parseTicketId } from './ticket.ts';

it('accepts an ID built from the alphabet', () => {
  expect(parseTicketId('tikk-ab3d')).toMatchObject({ ok: true, value: 'tikk-ab3d' });
  expect(parseTicketId('my-project-9zq7')).toMatchObject({ ok: true, value: 'my-project-9zq7' });
});

it.each(['tikk-abl3', 'tikk-ab03', 'tikk-abo3', 'tikk-abs3', 'tikk-ab1d', 'tikk-abu3'])(
  'rejects the look-alike character in %s',
  (value) => {
    const parsed = parseTicketId(value);

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason.message.length > 0).toBe(true);
  },
);

it.each(['tikk-ab3', 'tikk-ab3de', 'tikk', '-ab3d', 'TIKK-ab3d', 'tikk-AB3D'])(
  'rejects the malformed ID %s',
  (value) => {
    expect(parseTicketId(value).ok).toBe(false);
  },
);

it('accepts and rejects project names', () => {
  expect(parseProjectName('my-project2').ok).toBe(true);
  expect(parseProjectName('-project').ok).toBe(false);
  expect(parseProjectName('Project').ok).toBe(false);
  expect(parseProjectName('').ok).toBe(false);
});

it('splits a file name into its ID and slug', () => {
  const project = parseProjectName('tikk');

  expect(project.ok && parseTicketFileName('tikk-ab3d-my-slug.md', project.value)).toMatchObject({
    ok: true,
    value: { id: 'tikk-ab3d', slug: 'my-slug' },
  });
});

it('uses the known project prefix when the project contains a dash', () => {
  const project = parseProjectName('my-app');

  expect(project.ok && parseTicketFileName('my-app-ab3d-fix.md', project.value)).toMatchObject({
    ok: true,
    value: { id: 'my-app-ab3d', slug: 'fix' },
  });
});

it.each([
  'tikk-ab3d.md',
  'tikk-ab3d-.md',
  'tikk-ab3d-slug.txt',
  'other-ab3d-slug.md',
  'tikk-abl3-slug.md',
  'tikk-ab3dx-slug.md',
])('rejects the file name %s', (fileName) => {
  const project = parseProjectName('tikk');
  const parsed = project.ok ? parseTicketFileName(fileName, project.value) : project;

  expect(parsed.ok).toBe(false);
});
