import type { ListRow } from './rowList.tsx';

export interface TicketFileError {
  path: string;
  id: string | null;
  message: string;
}

export const errorsOfTicket = (errors: readonly TicketFileError[], id: string): TicketFileError[] =>
  errors.filter((error) => error.id === id);

const hasRow = (error: TicketFileError, rows: readonly ListRow[]): boolean =>
  error.id !== null && rows.some((row) => row.id === error.id);

export const strayErrorsOf = (
  errors: readonly TicketFileError[],
  rows: readonly ListRow[],
): TicketFileError[] => errors.filter((error) => !hasRow(error, rows));
