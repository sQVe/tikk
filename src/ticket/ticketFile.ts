import { z } from 'zod';

import type { Result } from '../result.ts';
import { ticketFrontMatterSchema } from './ticketSchema.ts';
import type { TicketFrontMatter } from './ticketSchema.ts';

export interface TicketFile {
  frontMatter: TicketFrontMatter;
  body: string;
}

export interface TicketFileReason {
  kind: 'missingFrontMatter' | 'invalidYaml' | 'invalidFrontMatter';
  message: string;
}

const frontMatterPattern = /^---\n(?:([\s\S]*?)\n)?---(?:\n([\s\S]*))?$/;

const fail = (
  kind: TicketFileReason['kind'],
  message: string,
): { ok: false; reason: TicketFileReason } => ({ ok: false, reason: { kind, message } });

export const parseTicketFile = (text: string): Result<TicketFile, TicketFileReason> => {
  const match = frontMatterPattern.exec(text);

  if (match === null) {
    return fail('missingFrontMatter', 'The file must start with a --- front matter block.');
  }

  let yaml: unknown;

  try {
    yaml = Bun.YAML.parse(match[1] ?? '');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    return fail('invalidYaml', `The front matter is not valid YAML: ${detail}`);
  }

  const parsed = ticketFrontMatterSchema.safeParse(yaml);

  if (!parsed.success) {
    return fail('invalidFrontMatter', z.prettifyError(parsed.error));
  }

  return { ok: true, value: { frontMatter: parsed.data, body: match[2] ?? '' } };
};

export const serializeTicketFile = (file: TicketFile): string => {
  const yaml = Bun.YAML.stringify(file.frontMatter, null, 2);

  return `---\n${yaml.trimEnd()}\n---\n${file.body}`;
};
