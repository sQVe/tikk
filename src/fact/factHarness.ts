import { invariant } from '../invariant.ts';
import { parseProjectName, parseTicketId } from '../ticket/ticket.ts';
import type { TicketFrontMatter } from '../ticket/ticket.ts';
import type { Fact, InstructionTicket, NeedItem } from './fact.ts';
import { parseFactLine } from './fact.ts';

export const now = new Date('2026-10-20T12:00:00.000Z');

export const reasonsOf = (items: NeedItem<InstructionTicket>[]): string[][] =>
  items.map((item) => [item.ticket.id, item.reason]);

export const instructionId = (suffix: string): InstructionTicket['id'] => {
  const parsed = parseTicketId(`me-${suffix}`);

  invariant(parsed.ok, `Test ID me-${suffix} is invalid.`);

  return parsed.value;
};

export const makeTicket = (
  suffix: string,
  overrides: Partial<Omit<TicketFrontMatter, 'blockedBy' | 'parent'>> & {
    blockedBy?: string[];
    parent?: string;
  } = {},
): InstructionTicket => {
  const { blockedBy = [], parent, ...rest } = overrides;
  const project = parseProjectName('me');

  invariant(project.ok, 'The test project should be valid.');

  return {
    id: instructionId(suffix),
    frontMatter: {
      kind: 'instruction',
      title: `Instruction ${suffix}`,
      project: project.value,
      status: 'open',
      ...rest,
      blockedBy: blockedBy.map(instructionId),
      discoveredFrom: [],
      related: [],
      ...(parent === undefined ? {} : { parent: instructionId(parent) }),
    },
  };
};

export const makeFact = (suffix: string, extra: Record<string, unknown>): Fact => {
  const parsed = parseFactLine(
    JSON.stringify({
      version: 1,
      ticket: `me-${suffix}`,
      at: '2026-10-20T10:00:00.000Z',
      machine: 'laptop',
      ...extra,
    }),
  );

  invariant(parsed.ok, 'The test fact should parse.');

  return parsed.value;
};
