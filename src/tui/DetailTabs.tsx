import { TextAttributes } from '@opentui/core';
import type { ReactNode } from 'react';

import type { TicketDetail } from '../cli/cli.ts';
import { activityLinesOf } from './activityTab.tsx';
import { detailOf, tabsOf } from './detailState.ts';
import type { DetailState, DetailTab } from './detailState.ts';
import type { Palette } from './palette.ts';
import { kindLabels } from './projectTree.ts';
import { singleLine } from './rowList.tsx';
import { wrapCells } from './textLayout.ts';

export interface TabLabel {
  tab: DetailTab;
  text: string;
  active: boolean;
}

const tabNames: Record<DetailTab, string> = {
  overview: 'Overview',
  criteria: 'Criteria',
  activity: 'Activity',
  links: 'Links',
};

const overviewSections = new Set(['Outcome', 'Files', 'First test']);
const sectionHeading = /^##\s+(.+?)\s*$/;
const lineBreak = /\r\n|[\r\n\u2028\u2029]/;
const linkLabelWidth = 16;

const instructionOverviewOf = (body: string): string[] => {
  const kept: string[] = [];
  let keeping = false;

  for (const line of body.split(lineBreak)) {
    const heading = sectionHeading.exec(line)?.[1];

    if (heading !== undefined) {
      keeping = overviewSections.has(heading);
    }

    if (keeping) {
      kept.push(line);
    }
  }

  return kept;
};

const overviewOf = (detail: TicketDetail): string[] => {
  const lines =
    detail.ticket.kind === 'instruction'
      ? instructionOverviewOf(detail.body)
      : detail.body.split(lineBreak);

  while (lines.at(-1)?.trim() === '') {
    lines.pop();
  }

  return lines;
};

const criteriaOf = (detail: TicketDetail): string[] =>
  (detail.ticket.criteria ?? []).flatMap((criterion) => [
    criterion.id,
    `  ${singleLine(criterion.check)}`,
    `  Expected: ${singleLine(criterion.expected)}`,
  ]);

const linkLine = (label: string, value: string): string =>
  `${label.padEnd(linkLabelWidth)}${value}`;

const prLinesOf = (pr: TicketDetail['pr']): string[] =>
  pr === null ? [] : [linkLine('PR', `#${pr.number}  ${pr.repository}  ${pr.state}`)];

const linksOf = (detail: TicketDetail): string[] => {
  const { ticket } = detail;
  const parent = ticket.parent === null ? [] : [linkLine('Parent', ticket.parent)];

  const children = detail.children.map((child) =>
    linkLine('Child', `${child.id}  ${kindLabels[child.kind]}  ${singleLine(child.title)}`),
  );

  return [
    ...parent,
    ...children,
    ...ticket.blockedBy.map((id) => linkLine('Blocked by', id)),
    ...ticket.related.map((id) => linkLine('Related', id)),
    ...ticket.discoveredFrom.map((id) => linkLine('Discovered from', id)),
    ...prLinesOf(detail.pr),
  ];
};

const linkCountOf = (detail: TicketDetail): number => {
  const { ticket } = detail;
  const parent = ticket.parent === null ? 0 : 1;
  const edges = ticket.blockedBy.length + ticket.related.length + ticket.discoveredFrom.length;
  const pr = detail.pr === null ? 0 : 1;

  return parent + detail.children.length + edges + pr;
};

const countOf = (tab: DetailTab, detail: TicketDetail | undefined): number | undefined => {
  if (detail === undefined) {
    return undefined;
  }

  if (tab === 'criteria') {
    return detail.ticket.criteria?.length ?? 0;
  }

  if (tab === 'activity') {
    return detail.facts.length;
  }

  return tab === 'links' ? linkCountOf(detail) : undefined;
};

const labelOf = (tab: DetailTab, detail: TicketDetail | undefined): string => {
  const count = countOf(tab, detail);

  return count === undefined ? tabNames[tab] : `${tabNames[tab]} ${count}`;
};

export const tabLabelsOf = (state: DetailState): TabLabel[] => {
  const detail = detailOf(state.load);

  return tabsOf(detail).map((tab) => ({
    tab,
    text: labelOf(tab, detail),
    active: tab === state.tab,
  }));
};

const stripTextOf = (label: TabLabel): string =>
  label.active ? `[${label.text}]` : ` ${label.text} `;

const stripWidthOf = (labels: readonly TabLabel[]): number =>
  labels.reduce((total, label) => total + stripTextOf(label).length, 0);

// Keeps the active label and adds neighbors, right first, while the strip fits the columns.
export const tabStripOf = (labels: readonly TabLabel[], columns: number): TabLabel[] => {
  const active = labels.findIndex((label) => label.active);
  let first = Math.max(0, active);
  let last = first;
  let grew = true;

  while (grew) {
    const fitsRight = stripWidthOf(labels.slice(first, last + 2)) <= columns;
    const fitsLeft = stripWidthOf(labels.slice(Math.max(0, first - 1), last + 1)) <= columns;
    const growsRight = last + 1 < labels.length && fitsRight;
    const growsLeft = first > 0 && fitsLeft;

    grew = growsRight || growsLeft;

    if (growsRight) {
      last += 1;
    } else if (growsLeft) {
      first -= 1;
    }
  }

  return labels.slice(first, last + 1);
};

const tabLinesOf = (tab: DetailTab, detail: TicketDetail): string[] => {
  if (tab === 'overview') {
    return overviewOf(detail);
  }

  if (tab === 'criteria') {
    return criteriaOf(detail);
  }

  if (tab === 'activity') {
    return activityLinesOf(detail.facts);
  }

  return linksOf(detail);
};

const loadLinesOf = (state: DetailState): string[] | undefined => {
  if (state.load.status === 'failed') {
    return [state.load.message];
  }

  return state.load.detail === undefined ? ['Loading...'] : undefined;
};

export const tabBodyOf = (state: DetailState, columns: number): string[] => {
  const detail = detailOf(state.load);
  const lines = detail === undefined ? (loadLinesOf(state) ?? []) : tabLinesOf(state.tab, detail);

  return lines.flatMap((line) => wrapCells(line, Math.max(1, columns)));
};

export const DetailTabs = (props: {
  labels: readonly TabLabel[];
  body: readonly string[];
  palette: Palette;
}): ReactNode => {
  const { palette } = props;

  return (
    <>
      <box flexDirection="row" height={1} flexShrink={0}>
        {props.labels.map((label) => (
          <text
            key={label.tab}
            fg={label.active ? palette.heading : palette.text}
            wrapMode="none"
            height={1}
            flexShrink={0}
            attributes={label.active ? TextAttributes.BOLD : TextAttributes.NONE}
          >
            {stripTextOf(label)}
          </text>
        ))}
      </box>
      {props.body.map((line, index) => (
        <text key={`body-${index}`} fg={palette.text} wrapMode="none" height={1} flexShrink={0}>
          {line}
        </text>
      ))}
    </>
  );
};
