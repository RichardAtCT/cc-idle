import React from 'react';
import { Composition } from 'remotion';
import { Demo } from './Demo';
import { DURATION, FPS } from './timeline';

export const Root: React.FC = () => (
  <>
    <Composition
      id="Demo"
      component={Demo}
      defaultProps={{ forGif: false }}
      durationInFrames={DURATION}
      fps={FPS}
      width={1920}
      height={1080}
    />
    <Composition
      id="DemoGif"
      component={Demo}
      defaultProps={{ forGif: true }}
      durationInFrames={DURATION}
      fps={FPS}
      width={1920}
      height={1080}
    />
  </>
);
