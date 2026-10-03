import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Easing,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { CUTS, FPS, FULL, INTRO_FRAMES, layout, type Camera, type Cut, type CutId, type Placed } from './timeline';

const C = {
  bg: '#11111b',
  term: '#1e1e2e',
  text: '#cdd6f4',
  dim: '#7f849c',
  orange: '#d97757',
  cyan: '#89dceb',
  magenta: '#f5c2e7',
};
const MONO = '"SF Mono", Menlo, Monaco, monospace';
const SANS = '-apple-system, "SF Pro Display", "Helvetica Neue", sans-serif';

// The raw take, framed: 1920x1080 shown at 1600x900.
const WIN = { w: 1600, h: 900, left: 160, top: 40 };
const WIN_SCALE = WIN.w / 1920;
const CAMERA_EASE_FRAMES = 24;
const OUTRO_HOLD = 18; // keep the video playing while the window leaves

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = Easing.bezier(0.33, 0, 0.2, 1);

function cameraAt(placed: Placed[], frame: number): Camera {
  const i = placed.findIndex((p) => frame < p.start + p.frames);
  const idx = i === -1 ? placed.length - 1 : i;
  const seg = placed[idx];
  const prev = idx === 0 ? FULL : placed[idx - 1].camera;
  const t = ease(Math.min(1, Math.max(0, (frame - seg.start) / CAMERA_EASE_FRAMES)));
  return {
    scale: lerp(prev.scale, seg.camera.scale, t),
    x: lerp(prev.x, seg.camera.x, t),
    y: lerp(prev.y, seg.camera.y, t),
  };
}

// Translate so the camera point sits mid-window, without showing past the edges.
function cameraTransform({ scale, x, y }: Camera): string {
  const clamp = (v: number, size: number) => Math.min(0, Math.max(size - size * scale, v));
  const tx = clamp(960 - x * scale, 1920);
  const ty = clamp(540 - y * scale, 1080);
  return `translate(${tx}px, ${ty}px) scale(${scale})`;
}

// Static on purpose: a moving gradient changes every pixel of every frame.
// The GIF gets a flat colour, because a 256-colour palette bands a gradient.
const Background: React.FC<{ flat: boolean }> = ({ flat }) => {
  return (
    <AbsoluteFill
      style={{
        background: flat
          ? C.bg
          : `radial-gradient(circle at 20% 15%, rgba(217,119,87,0.28), transparent 45%),
          radial-gradient(circle at 85% 90%, rgba(137,180,250,0.22), transparent 50%),
          ${C.bg}`,
      }}
    />
  );
};

// A ticker that starts with a number counts up to it; any other ticker types out.
function tickerText(ticker: string, t: number): string {
  const counted = /^([\d.]+)(.*)$/.exec(ticker);
  if (counted) return `${(Number(counted[1]) * t).toFixed(1)}${counted[2]}`;
  return ticker.slice(0, Math.round(ticker.length * t));
}

const Intro: React.FC<{ intro: Cut['intro'] }> = ({ intro }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 12, mass: 0.6 } });
  const sub = spring({ frame: frame - 10, fps, config: { damping: 200 } });
  const t = interpolate(frame, [15, INTRO_FRAMES - 22], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  const out = interpolate(frame, [INTRO_FRAMES - 20, INTRO_FRAMES - 6], [1, 0], { extrapolateLeft: 'clamp' });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', opacity: out }}>
      <div
        style={{
          fontFamily: MONO,
          fontWeight: 800,
          fontSize: 160,
          color: C.orange,
          letterSpacing: -4,
          transform: `scale(${0.6 + 0.4 * pop})`,
          textShadow: '0 0 60px rgba(217,119,87,0.45)',
        }}
      >
        {intro.title}
      </div>
      <div
        style={{
          fontFamily: SANS,
          fontSize: 44,
          color: C.text,
          marginTop: 12,
          opacity: sub,
          transform: `translateY(${(1 - sub) * 20}px)`,
        }}
      >
        {intro.tagline}
      </div>
      <div style={{ fontFamily: MONO, fontSize: 40, color: C.cyan, marginTop: 36, opacity: sub, minHeight: 48 }}>
        {tickerText(intro.ticker, t)}
      </div>
    </AbsoluteFill>
  );
};

const Window: React.FC<{ take: string; placed: Placed[]; bodyEnd: number }> = ({ take, placed, bodyEnd }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - (INTRO_FRAMES - 6), fps, config: { damping: 18 } });
  const leave = interpolate(frame, [bodyEnd, bodyEnd + OUTRO_HOLD], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const opacity = Math.min(enter, leave);
  if (opacity <= 0) return null;
  const scale = (0.92 + 0.08 * enter) * (0.94 + 0.06 * leave);
  const last = placed.length - 1;
  return (
    <div
      style={{
        position: 'absolute',
        left: WIN.left,
        top: WIN.top,
        width: WIN.w,
        height: WIN.h,
        borderRadius: 18,
        overflow: 'hidden',
        background: C.term,
        opacity,
        transform: `scale(${scale})`,
        boxShadow: '0 40px 120px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.08)',
      }}
    >
      <div
        style={{
          width: 1920,
          height: 1080,
          transformOrigin: '0 0',
          transform: `scale(${WIN_SCALE}) ${cameraTransform(cameraAt(placed, frame))}`,
        }}
      >
        {placed.map((p, i) => (
          <Sequence
            key={p.from}
            from={p.start}
            durationInFrames={p.frames + (i === last ? OUTRO_HOLD : 0)}
            layout="none"
          >
            <OffthreadVideo
              src={staticFile(take)}
              trimBefore={Math.round(p.from * FPS)}
              playbackRate={p.rate}
              muted
              style={{ position: 'absolute', width: 1920, height: 1080 }}
            />
          </Sequence>
        ))}
      </div>
    </div>
  );
};

// Neighbouring segments with the same caption share one card.
function captions(placed: Placed[]): { text: string; start: number; end: number }[] {
  return placed.reduce<{ text: string; start: number; end: number }[]>((acc, p) => {
    const prev = acc[acc.length - 1];
    if (prev && prev.text === p.caption) prev.end = p.start + p.frames;
    else acc.push({ text: p.caption, start: p.start, end: p.start + p.frames });
    return acc;
  }, []);
}

const Caption: React.FC<{ text: string; frames: number }> = ({ text, frames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 16 } });
  const out = interpolate(frame, [frames - 8, frames], [1, 0], { extrapolateLeft: 'clamp' });
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 34 }}>
      <div
        style={{
          fontFamily: SANS,
          fontWeight: 600,
          fontSize: 38,
          color: C.text,
          padding: '14px 32px',
          borderRadius: 999,
          background: 'rgba(30,30,46,0.85)',
          border: `2px solid ${C.orange}`,
          opacity: enter * out,
          transform: `translateY(${(1 - enter) * 24}px)`,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

const Outro: React.FC<{ outro: Cut['outro'] }> = ({ outro }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const at = (delay: number) => spring({ frame: frame - delay, fps, config: { damping: 18 } });
  const line = (delay: number): React.CSSProperties => ({
    opacity: at(delay),
    transform: `translateY(${(1 - at(delay)) * 24}px)`,
  });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', fontFamily: SANS }}>
      <div style={{ fontSize: 84, fontWeight: 700, color: C.text, ...line(4) }}>{outro.headline}</div>
      {outro.note && <div style={{ fontSize: 36, color: C.dim, marginTop: 18, ...line(10) }}>{outro.note}</div>}
      <div
        style={{
          marginTop: 48,
          padding: '28px 44px',
          borderRadius: 18,
          background: C.term,
          border: '1px solid rgba(255,255,255,0.1)',
          fontFamily: MONO,
          fontSize: 38,
          lineHeight: 1.6,
          color: C.text,
          ...line(16),
        }}
      >
        <div>
          <span style={{ color: C.orange }}>&gt;</span> /plugin marketplace add RichardAtCT/cc-idle
        </div>
        <div>
          <span style={{ color: C.orange }}>&gt;</span> /plugin install cc-idle@cc-idle
        </div>
      </div>
      <div style={{ marginTop: 44, fontFamily: MONO, fontSize: 36, color: C.cyan, ...line(28) }}>
        github.com/RichardAtCT/cc-idle
      </div>
    </AbsoluteFill>
  );
};

export type DemoProps = { cut: CutId; forGif: boolean };

export const Demo: React.FC<DemoProps> = ({ cut: id, forGif }) => {
  const frame = useCurrentFrame();
  const cut: Cut = CUTS[id];
  const { placed, bodyEnd, duration } = layout(cut);
  const music = (f: number) =>
    interpolate(f, [0, 15, duration - 45, duration], [0, 0.8, 0.8, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  return (
    <AbsoluteFill>
      <Background flat={forGif} />
      {!forGif && <Audio src={staticFile('music.wav')} volume={music} />}
      {frame < INTRO_FRAMES && <Intro intro={cut.intro} />}
      <Window take={cut.take} placed={placed} bodyEnd={bodyEnd} />
      {captions(placed).map((c) => (
        <Sequence key={c.start} from={c.start} durationInFrames={c.end - c.start}>
          <Caption text={c.text} frames={c.end - c.start} />
        </Sequence>
      ))}
      <Sequence from={bodyEnd + 6}>
        <Outro outro={cut.outro} />
      </Sequence>
    </AbsoluteFill>
  );
};
