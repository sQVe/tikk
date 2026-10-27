export type OverlayMove =
  | { kind: 'lines'; lines: number }
  | { kind: 'edge'; edge: 'top' | 'bottom' };

export const topAfter = (top: number, move: OverlayMove, maximumTop: number): number => {
  if (move.kind === 'edge') {
    return move.edge === 'bottom' ? maximumTop : 0;
  }

  const current = Math.min(top, maximumTop);

  return Math.min(maximumTop, Math.max(0, current + move.lines));
};
