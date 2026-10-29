import type { NeedView } from '../cli/cli.ts';
import { attentionLinesOf, cutAttention } from './AttentionBlock.tsx';
import { headerLinesOf } from './DetailHeader.tsx';
import type { DetailState } from './detailState.ts';
import { tabBodyOf, tabLabelsOf, tabStripOf } from './DetailTabs.tsx';
import type { TabLabel } from './DetailTabs.tsx';
import type { TicketFileError } from './fileErrors.ts';
import type { IconSet } from './ticketIcons.ts';

export interface DetailWindow {
  header: readonly string[];
  attention: readonly string[];
  tabs: readonly TabLabel[];
  body: readonly string[];
  bodyRows: number;
  maximumTop: number;
}

export interface DetailWindowInput {
  state: DetailState;
  id: string;
  needs: readonly NeedView[];
  errors: readonly TicketFileError[];
  icons: IconSet;
  columns: number;
  rows: number;
}

const collapsedAttentionRows = 4;
const minimumBodyRows = 10;
const tabBarRows = 1;

export const detailWindowOf = (input: DetailWindowInput): DetailWindow => {
  const { state, columns, rows } = input;
  const header = headerLinesOf(state, input.id, input.icons, input.errors);
  const spareRows = rows - header.length - tabBarRows - minimumBodyRows;

  const attentionLimit = state.attentionExpanded
    ? Math.max(collapsedAttentionRows, spareRows)
    : collapsedAttentionRows;

  const allAttention = attentionLinesOf(input.needs, input.id, input.icons, columns);
  const attention = cutAttention(allAttention, attentionLimit);
  const bodyRows = Math.max(0, rows - header.length - attention.length - tabBarRows);
  const lines = tabBodyOf(state, columns);
  const maximumTop = Math.max(0, lines.length - bodyRows);
  const top = Math.min(state.top, maximumTop);

  return {
    header,
    attention,
    tabs: tabStripOf(tabLabelsOf(state), columns),
    body: lines.slice(top, top + bodyRows),
    bodyRows,
    maximumTop,
  };
};
