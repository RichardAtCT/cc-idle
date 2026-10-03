// One table drives the cut: which seconds of the raw VHS take to show, how
// fast, where the camera looks, and the caption. Beat times come from
// demo/out/demo.mp4; re-check them after a new take.

export const FPS = 30;
export const INTRO_FRAMES = 75;
export const OUTRO_FRAMES = 135;

// The raw take is 1920x1080. The game pane spans x 1036-1890.
export type Camera = { scale: number; x: number; y: number };
const FULL: Camera = { scale: 1, x: 960, y: 540 };
const PANE_TOP: Camera = { scale: 2.15, x: 1478, y: 270 };
const WELCOME: Camera = { scale: 2.15, x: 1478, y: 250 };

export type Segment = {
  from: number; // source seconds
  to: number;
  rate: number;
  camera: Camera;
  caption: string;
};

export const SEGMENTS: Segment[] = [
  { from: 0, to: 6, rate: 1, camera: WELCOME, caption: 'Install the mod. The game opens beside Claude Code.' },
  { from: 6, to: 11, rate: 2.5, camera: FULL, caption: '/idle takes the keyboard. Esc hands it back.' },
  { from: 11, to: 16, rate: 1.6, camera: FULL, caption: 'Give Claude real work.' },
  { from: 16, to: 22.4, rate: 1.3, camera: PANE_TOP, caption: 'Output tokens become FLOPS. Edits become engineering.' },
  { from: 22.4, to: 26, rate: 1, camera: FULL, caption: 'Claude needs you? The pane says so.' },
  { from: 26, to: 28.6, rate: 2, camera: FULL, caption: 'Claude needs you? The pane says so.' },
  { from: 28.6, to: 33.8, rate: 1, camera: PANE_TOP, caption: 'Turn done: milestone shipped, bonus paid.' },
  { from: 33.8, to: 38, rate: 1, camera: PANE_TOP, caption: 'Spend it. g buys a GPU, so every token earns more.' },
];

export type Placed = Segment & { start: number; frames: number };

// Each segment's start and length in output frames.
export const PLACED: Placed[] = SEGMENTS.reduce<Placed[]>((acc, seg) => {
  const prev = acc[acc.length - 1];
  const start = prev ? prev.start + prev.frames : INTRO_FRAMES;
  const frames = Math.round(((seg.to - seg.from) / seg.rate) * FPS);
  return [...acc, { ...seg, start, frames }];
}, []);

const last = PLACED[PLACED.length - 1];
export const BODY_END = last.start + last.frames;
export const DURATION = BODY_END + OUTRO_FRAMES;
