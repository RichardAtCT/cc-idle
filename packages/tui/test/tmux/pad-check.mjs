/**
 * Asks Ink to render a bordered row containing a candidate glyph, then reports
 * how Ink padded it: string length vs string-width. If Ink's padding makes the
 * row's string-width equal the box width, Ink and string-width agree.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { render, cleanup } from 'ink-testing-library';
import stringWidth from 'string-width';

const glyphs = [...(process.argv.slice(2).join('') || '⚡↯✔▪')];

for (const g of glyphs) {
  const { lastFrame } = render(
    React.createElement(
      Box,
      { borderStyle: 'round', paddingX: 1, width: 40 },
      React.createElement(Text, null, `${g} marker`)
    )
  );
  const line = (lastFrame() ?? '').split('\n')[1] ?? '';
  const cp = g.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  console.log(
    `${g} U+${cp}  length=${line.length}  stringWidth=${stringWidth(line)}  boxWidth=40`
  );
  cleanup();
}
