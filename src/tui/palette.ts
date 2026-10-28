import { RGBA } from '@opentui/core';

export interface Palette {
  text: RGBA;
  key: RGBA;
  heading: RGBA;
  overlayBackground: RGBA;
}

const ansiYellow = 3;
const ansiBlue = 4;

export const palette: Palette = {
  text: RGBA.defaultForeground(),
  key: RGBA.fromIndex(ansiYellow),
  heading: RGBA.fromIndex(ansiBlue),
  overlayBackground: RGBA.defaultBackground(),
};
