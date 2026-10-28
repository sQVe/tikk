const segmenter = new Intl.Segmenter();

const ellipsis = '…';

const cellWidth = (text: string): number => {
  let total = 0;

  for (const { segment } of segmenter.segment(text)) {
    total += Bun.stringWidth(segment);
  }

  return total;
};

export const fitText = (text: string, columns: number): string => {
  if (columns < 1) {
    return '';
  }

  if (cellWidth(text) <= columns) {
    return text;
  }

  const room = columns - Bun.stringWidth(ellipsis);
  let kept = '';
  let keptWidth = 0;

  for (const { segment } of segmenter.segment(text)) {
    const width = Bun.stringWidth(segment);

    if (keptWidth + width > room) {
      break;
    }

    kept += segment;
    keptWidth += width;
  }

  return `${kept}${ellipsis}`;
};

export const wrapCells = (text: string, columns: number): string[] => {
  const chunks: string[] = [];
  let current = '';
  let currentWidth = 0;

  for (const { segment } of segmenter.segment(text)) {
    const width = Bun.stringWidth(segment);

    if (current !== '' && currentWidth + width > columns) {
      chunks.push(current);
      current = '';
      currentWidth = 0;
    }

    current += segment;
    currentWidth += width;
  }

  chunks.push(current);

  return chunks;
};
