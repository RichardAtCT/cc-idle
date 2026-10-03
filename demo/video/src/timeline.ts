// One table per cut drives it: which seconds of the raw VHS take to show, how
// fast, where the camera looks, and the caption. Beat times come from the
// take in demo/out/<take>; re-check them after a new take.

export const FPS = 30;
export const INTRO_FRAMES = 75;
export const OUTRO_FRAMES = 150;

// The raw takes are 1920x1080. The game pane spans x 1036-1890.
export type Camera = { scale: number; x: number; y: number };
export const FULL: Camera = { scale: 1, x: 960, y: 540 };
const PANE_TOP: Camera = { scale: 2.15, x: 1478, y: 270 };
const WELCOME: Camera = { scale: 2.15, x: 1478, y: 250 };
const TRANSCRIPT: Camera = { scale: 1.7, x: 565, y: 330 };

export type Segment = {
  from: number; // source seconds
  to: number;
  rate: number;
  camera: Camera;
  caption: string;
};

export type Cut = {
  take: string; // in public/
  segments: Segment[];
  intro: { title: string; tagline: string; ticker: string };
  outro: { headline: string; note?: string };
};

export const CUTS = {
  // The whole loop: Claude works, the pane pays out, you spend it.
  demo: {
    take: 'demo.mp4',
    intro: { title: 'CC Idle', tagline: "An idle game that runs on Claude Code's real work.", ticker: '741.3 FLOPS' },
    outro: { headline: 'Play while Claude works.' },
    segments: [
      { from: 0, to: 6, rate: 1, camera: WELCOME, caption: 'Install the mod. The game opens beside Claude Code.' },
      { from: 6, to: 11, rate: 2.5, camera: FULL, caption: '/idle takes the keyboard. Esc hands it back.' },
      { from: 11, to: 16, rate: 1.6, camera: FULL, caption: 'Give Claude real work.' },
      { from: 16, to: 22.4, rate: 1.3, camera: PANE_TOP, caption: 'Output tokens become FLOPS. Edits become engineering.' },
      { from: 22.4, to: 26, rate: 1, camera: FULL, caption: 'Claude needs you? The pane says so.' },
      { from: 26, to: 28.6, rate: 2, camera: FULL, caption: 'Claude needs you? The pane says so.' },
      { from: 28.6, to: 33.8, rate: 1, camera: PANE_TOP, caption: 'Turn done: milestone shipped, bonus paid.' },
      { from: 33.8, to: 38, rate: 1, camera: PANE_TOP, caption: 'Spend it. g buys a GPU, so every token earns more.' },
    ],
  },
  // The Haiku board member, alone.
  board: {
    take: 'board.mp4',
    intro: {
      title: 'The Board',
      tagline: 'A Haiku board member lives in your CC Idle pane.',
      ticker: "☞ datacenters need 250K we won't see for weeks.",
    },
    outro: { headline: 'Ask the board.', note: 'Each line is one small Haiku call on your own account.' },
    segments: [
      { from: 1, to: 8, rate: 1.8, camera: TRANSCRIPT, caption: 'Claude runs a command. It fails.' },
      { from: 8, to: 11.5, rate: 1, camera: PANE_TOP, caption: 'New mechanic? The board explains it, unasked.' },
      { from: 11.5, to: 16, rate: 2.5, camera: PANE_TOP, caption: 'Press c to talk to the board.' },
      { from: 16, to: 20, rate: 1, camera: PANE_TOP, caption: 'It is Haiku, in character, with one concrete tip.' },
      { from: 20, to: 24, rate: 1.3, camera: PANE_TOP, caption: 'Ask it how the game works…' },
      { from: 24, to: 29.5, rate: 1, camera: PANE_TOP, caption: '…it answers from the real balance numbers.' },
      { from: 29.5, to: 33, rate: 1.3, camera: PANE_TOP, caption: 'Or ask what it thinks.' },
      { from: 33, to: 39, rate: 1, camera: PANE_TOP, caption: 'Dry, and a little anxious about burn rate.' },
      { from: 39, to: 41.8, rate: 1, camera: PANE_TOP, caption: 'Its last word stays under the hint.' },
    ],
  },
} satisfies Record<string, Cut>;

export type CutId = keyof typeof CUTS;

export type Placed = Segment & { start: number; frames: number };

export type Layout = { placed: Placed[]; bodyEnd: number; duration: number };

// Each segment's start and length in output frames, and the cut's total.
export function layout(cut: Cut): Layout {
  const placed = cut.segments.reduce<Placed[]>((acc, seg) => {
    const prev = acc[acc.length - 1];
    const start = prev ? prev.start + prev.frames : INTRO_FRAMES;
    const frames = Math.round(((seg.to - seg.from) / seg.rate) * FPS);
    return [...acc, { ...seg, start, frames }];
  }, []);
  const last = placed[placed.length - 1];
  const bodyEnd = last.start + last.frames;
  return { placed, bodyEnd, duration: bodyEnd + OUTRO_FRAMES };
}
