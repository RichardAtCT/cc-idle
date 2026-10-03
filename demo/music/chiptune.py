"""Original 8-bit loop for the cc-idle demo video.

Usage: python3 chiptune.py OUT.wav [SECONDS]

C - G - Am - F at 132 BPM. Arpeggio from bar 1, bass and drums from bar 3,
lead from bar 7. Squares and noise drums go through one-pole low-passes, and the mix
peaks at -12 dBFS so the track sits under the video, not on top of it.
"""

import sys
import wave

import numpy as np

SR = 44100
BPM = 132
BEAT = 60 / BPM
BAR = 4 * BEAT
STEP = BEAT / 4  # a sixteenth

CHORDS = [  # MIDI notes, root position
    [48, 52, 55],  # C
    [43, 47, 50],  # G
    [45, 48, 52],  # Am
    [41, 45, 48],  # F
]

# The lead in eighths, two four-bar phrases. None rests, '.' holds.
E5, G5, C6, D5, B5, B4, A5, F5, C5, D6, E6 = 76, 79, 84, 74, 83, 71, 81, 77, 72, 86, 88
LEAD = [
    E5,
    G5,
    C6,
    G5,
    E5,
    ".",
    D5,
    E5,
    D5,
    G5,
    B5,
    G5,
    D5,
    ".",
    B4,
    D5,
    C5,
    E5,
    A5,
    E5,
    C6,
    ".",
    B5,
    A5,
    A5,
    ".",
    G5,
    ".",
    F5,
    E5,
    D5,
    None,
    E5,
    G5,
    C6,
    D6,
    E6,
    ".",
    D6,
    C6,
    B5,
    ".",
    G5,
    ".",
    D6,
    ".",
    B5,
    G5,
    A5,
    C6,
    E6,
    C6,
    A5,
    ".",
    G5,
    E5,
    F5,
    ".",
    A5,
    ".",
    G5,
    ".",
    ".",
    None,
]


def hz(note):
    return 440.0 * 2 ** ((note - 69) / 12)


def envelope(n, attack=0.004, release=0.06):
    env = np.ones(n)
    a = min(n, int(attack * SR))
    r = min(n - a, int(release * SR))
    env[:a] = np.linspace(0, 1, a, endpoint=False)
    if r:
        env[n - r :] = np.linspace(1, 0, r)
    return env


def square(freq, dur, duty=0.5, vibrato=0.0):
    t = np.arange(int(dur * SR)) / SR
    f = freq * (1 + vibrato * np.sin(2 * np.pi * 5.5 * t) * np.clip(t * 4, 0, 1))
    phase = np.cumsum(f) / SR % 1
    return np.where(phase < duty, 1.0, -1.0) * envelope(len(t))


def triangle(freq, dur):
    t = np.arange(int(dur * SR)) / SR
    phase = t * freq % 1
    return (4 * np.abs(phase - 0.5) - 1) * envelope(len(t), release=0.03)


def kick():
    t = np.arange(int(0.16 * SR)) / SR
    freq = 45 + 110 * np.exp(-t * 35)
    return np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-t * 22)


def noise(dur, decay, rng):
    t = np.arange(int(dur * SR)) / SR
    hiss = rng.uniform(-1, 1, len(t))
    hiss = np.diff(hiss, prepend=0)  # tilt toward the highs
    return hiss * np.exp(-t * decay)


def lowpass(x, cutoff):
    alpha = 1 - np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i, v in enumerate(x):
        acc += alpha * (v - acc)
        y[i] = acc
    return y


def place(track, sound, at, gain):
    i = int(at * SR)
    end = min(len(track), i + len(sound))
    if i < end:
        track[i:end] += sound[: end - i] * gain


def render(seconds):
    n = int(seconds * SR)
    rng = np.random.default_rng(7)
    square_bus = np.zeros(n)
    noise_bus = np.zeros(n)
    mix = np.zeros(n)
    bars = int(np.ceil(seconds / BAR))

    for bar in range(bars):
        t0 = bar * BAR
        chord = CHORDS[bar % 4]
        tones = [chord[0] + 24, chord[1] + 24, chord[2] + 24, chord[0] + 36]

        for s in range(16):  # arpeggio
            place(
                square_bus,
                square(hz(tones[s % 4]), STEP * 0.9, duty=0.25),
                t0 + s * STEP,
                0.10,
            )

        if bar >= 2:
            for e, octave in enumerate([0, 0, 12, 0, 0, 12, 0, 12]):  # bass in eighths
                place(
                    mix,
                    triangle(hz(chord[0] - 12 + octave), BEAT / 2 * 0.95),
                    t0 + e * BEAT / 2,
                    0.42,
                )
            for b in range(4):
                if b in (0, 2) or (b == 3 and bar % 2):
                    place(mix, kick(), t0 + b * BEAT, 0.7)
                if b in (1, 3):
                    place(noise_bus, noise(0.14, 28, rng), t0 + b * BEAT, 0.30)
            for e in range(8):
                place(
                    mix,
                    noise(0.04, 90, rng),
                    t0 + e * BEAT / 2,
                    0.07 if e % 2 else 0.04,
                )

        if bar >= 6:  # lead
            phrase = LEAD[((bar - 6) % 8) * 8 : ((bar - 6) % 8) * 8 + 8]
            e = 0
            while e < 8:
                note = phrase[e]
                hold = 1
                while e + hold < 8 and phrase[e + hold] == ".":
                    hold += 1
                if isinstance(note, int):
                    dur = hold * BEAT / 2 * 0.92
                    place(
                        square_bus,
                        square(hz(note), dur, duty=0.5, vibrato=0.006),
                        t0 + e * BEAT / 2,
                        0.12,
                    )
                e += hold

    mix += lowpass(square_bus, 4500) + lowpass(noise_bus, 3500)
    t = np.arange(n) / SR
    mix *= np.clip(t / 0.3, 0, 1)  # no click at the start
    peak = np.max(np.abs(mix))
    return mix / peak * 10 ** (-12 / 20)


def main():
    out = sys.argv[1]
    seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 45.0
    pcm = (render(seconds) * 32767).astype("<i2")
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


if __name__ == "__main__":
    main()
