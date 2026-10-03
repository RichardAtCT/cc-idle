import React from 'react';
import { Composition } from 'remotion';
import { Demo } from './Demo';
import { CUTS, FPS, layout, type CutId } from './timeline';

// Each cut renders twice: with music (MP4), and silent on a flat background (GIF).
export const Root: React.FC = () => (
  <>
    {(Object.keys(CUTS) as CutId[]).flatMap((cut) => {
      const name = cut[0].toUpperCase() + cut.slice(1);
      const common = { component: Demo, durationInFrames: layout(CUTS[cut]).duration, fps: FPS, width: 1920, height: 1080 };
      return [
        <Composition key={name} id={name} {...common} defaultProps={{ cut, forGif: false }} />,
        <Composition key={`${name}Gif`} id={`${name}Gif`} {...common} defaultProps={{ cut, forGif: true }} />,
      ];
    })}
  </>
);
