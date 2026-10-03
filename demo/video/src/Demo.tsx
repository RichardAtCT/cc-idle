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
import { BODY_END, DURATION, FPS, INTRO_FRAMES, PLACED, type Camera } from './timeline';

const C = {
  bg: '#11111b',
  term: '#1e1e2e',
  text: '#cdd6f4',
  dim: '#7f849c',
  orange: '#d97757',
  cyan: '#89dceb',
  yellow: '#f9e2af',
};
const MONO = '"SF Mono", Menlo, Monaco, monospace';
const SANS = '-apple-system, "SF Pro Display", "Helvetica Neue", sans-serif';

// The raw take, framed: 1920x1080 shown at 1600x900.
const WIN = { w: 1600, h: 900, left: 160, top: 40 };
const WIN_SCALE = WIN.w / 1920;
const FULL: Camera = { scale: 1, x: 960, y: 540 };
const CAMERA_EASE_FRAMES = 24;
const OUTRO_HOLD = 18; // keep the video playing while the window leaves

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = Easing.bezier(0.33, 0, 0.2, 1);

function cameraAt(frame: number): Camera {
  const i = PLACED.findIndex((p) => frame < p.start + p.frames);
  const idx = i === -1 ? PLACED.length - 1 : i;
  const seg = PLACED[idx];
  const prev = idx === 0 ? FULL : PLACED[idx - 1].camera;
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

const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 12, mass: 0.6 } });
  const sub = spring({ frame: frame - 10, fps, config: { damping: 200 } });
  const flops = interpolate(frame, [15, INTRO_FRAMES - 15], [0, 741.3], {
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
        CC Idle
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
        An idle game that runs on Claude Code&apos;s real work.
      </div>
      <div style={{ fontFamily: MONO, fontSize: 40, color: C.cyan, marginTop: 36, opacity: sub }}>
        {flops.toFixed(1)} FLOPS
      </div>
    </AbsoluteFill>
  );
};

const Window: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - (INTRO_FRAMES - 6), fps, config: { damping: 18 } });
  const leave = interpolate(frame, [BODY_END, BODY_END + OUTRO_HOLD], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const opacity = Math.min(enter, leave);
  if (opacity <= 0) return null;
  const scale = (0.92 + 0.08 * enter) * (0.94 + 0.06 * leave);
  const last = PLACED.length - 1;
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
          transform: `scale(${WIN_SCALE}) ${cameraTransform(cameraAt(frame))}`,
        }}
      >
        {PLACED.map((p, i) => (
          <Sequence
            key={p.from}
            from={p.start}
            durationInFrames={p.frames + (i === last ? OUTRO_HOLD : 0)}
            layout="none"
          >
            <OffthreadVideo
              src={staticFile('demo.mp4')}
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
const CAPTIONS = PLACED.reduce<{ text: string; start: number; end: number }[]>((acc, p) => {
  const prev = acc[acc.length - 1];
  if (prev && prev.text === p.caption) prev.end = p.start + p.frames;
  else acc.push({ text: p.caption, start: p.start, end: p.start + p.frames });
  return acc;
}, []);

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

const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const at = (delay: number) => spring({ frame: frame - delay, fps, config: { damping: 18 } });
  const line = (delay: number): React.CSSProperties => ({
    opacity: at(delay),
    transform: `translateY(${(1 - at(delay)) * 24}px)`,
  });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', fontFamily: SANS }}>
      <div style={{ fontSize: 84, fontWeight: 700, color: C.text, ...line(4) }}>Play while Claude works.</div>
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
          ...line(14),
        }}
      >
        <div>
          <span style={{ color: C.orange }}>&gt;</span> /plugin marketplace add RichardAtCT/cc-idle
        </div>
        <div>
          <span style={{ color: C.orange }}>&gt;</span> /plugin install cc-idle@cc-idle
        </div>
      </div>
      <div style={{ marginTop: 44, fontFamily: MONO, fontSize: 36, color: C.cyan, ...line(26) }}>
        github.com/RichardAtCT/cc-idle
      </div>
    </AbsoluteFill>
  );
};

export type DemoProps = { forGif: boolean };

export const Demo: React.FC<DemoProps> = ({ forGif }) => {
  const frame = useCurrentFrame();
  const music = (f: number) =>
    interpolate(f, [0, 15, DURATION - 45, DURATION], [0, 0.8, 0.8, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  return (
    <AbsoluteFill>
      <Background flat={forGif} />
      {!forGif && <Audio src={staticFile('music.wav')} volume={music} />}
      {frame < INTRO_FRAMES && <Intro />}
      <Window />
      {CAPTIONS.map((c) => (
        <Sequence key={c.start} from={c.start} durationInFrames={c.end - c.start}>
          <Caption text={c.text} frames={c.end - c.start} />
        </Sequence>
      ))}
      <Sequence from={BODY_END + 6}>
        <Outro />
      </Sequence>
    </AbsoluteFill>
  );
};
