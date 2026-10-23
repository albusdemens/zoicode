import { useEffect, useState } from 'react';

export type CatMood = 'idle' | 'working' | 'alert' | 'happy' | 'sad' | 'sleep';

type Step = [frame: string, ms: number];

const BASE: Record<CatMood, string> = {
  idle: 'open',
  working: 'open',
  alert: 'twitch', // tail up: listening
  happy: 'closed', // content
  sad: 'half',
  sleep: 'closed',
};

/** Little things the cat does now and then; the subtle ones are the most frequent. */
const ACTIONS: { weight: number; idleOnly?: boolean; steps: () => Step[] }[] = [
  // a quick blink
  { weight: 42, steps: () => [['half', 70], ['closed', 110], ['half', 70]] },
  // a double blink
  { weight: 10, steps: () => [['half', 60], ['closed', 90], ['half', 60], ['open', 170], ['half', 60], ['closed', 90], ['half', 60]] },
  // a slow, content blink (a cat's "I like you")
  { weight: 14, idleOnly: true, steps: () => [['half', 200], ['closed', 1400], ['half', 240]] },
  // a tail flick
  { weight: 34, steps: () => [['twitch', 260], ['open', 180], ['twitch', 220]] },
];

function pickAction(mood: CatMood): Step[] {
  const options = ACTIONS.filter(a => !a.idleOnly || mood === 'idle');
  let r = Math.random() * options.reduce((s, a) => s + a.weight, 0);
  for (const a of options) {
    r -= a.weight;
    if (r <= 0) return a.steps();
  }
  return options[0].steps();
}

/**
 * Makes the cat fidget: it holds still most of the time and every few seconds does one small
 * thing (a blink, a slow blink, a tail flick), a bit more often while Raon works.
 * Calls onFrame with each frame to show; returns a function that stops it.
 */
export function fidget(mood: CatMood, onFrame: (frame: string) => void): () => void {
  const base = BASE[mood];
  onFrame(base);
  if (mood !== 'idle' && mood !== 'working') return () => {};
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;
  const schedule = () => {
    const [lo, hi] = mood === 'working' ? [2500, 5000] : [3500, 8500];
    timer = setTimeout(play, lo + Math.random() * (hi - lo));
  };
  const play = () => {
    const steps = pickAction(mood);
    let i = 0;
    const next = () => {
      if (cancelled) return;
      if (i >= steps.length) {
        onFrame(base);
        return schedule();
      }
      const [f, ms] = steps[i++];
      onFrame(f);
      timer = setTimeout(next, ms);
    };
    next();
  };
  schedule();
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

/** The cat's current frame, for React components. */
export function useCatFrame(mood: CatMood, enabled = true): string {
  const [frame, setFrame] = useState(BASE[mood]);
  useEffect(() => (enabled ? fidget(mood, setFrame) : setFrame(BASE[mood])), [mood, enabled]);
  return frame;
}

export interface CatPose {
  frame: string;
  x: number;
  y: number;
  done: boolean;
}

const ease = (p: number) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);

/** Timings of the trip to the prompt box, in ms. */
export const JOURNEY = { notice: 220, crouch: 160, hop: 720, land: 110, settle: 520 };
export const JOURNEY_MS = Object.values(JOURNEY).reduce((a, b) => a + b, 0);

/**
 * Where the cat is `t` ms after the user presses Enter: it pricks up its tail, crouches, hops off
 * the desk in an arc and lands on the prompt box with a little squash, then settles with a content
 * blink. Coordinates are in pixels, in the scene's coordinate space.
 */
export function catJourney(t: number, home: { x: number; y: number }, dest: { x: number; y: number }): CatPose {
  const J = JOURNEY;
  if (t < J.notice) return { frame: 'twitch', x: home.x, y: home.y, done: false };
  t -= J.notice;
  if (t < J.crouch) return { frame: 'half', x: home.x, y: home.y + 1, done: false };
  t -= J.crouch;
  if (t < J.hop) {
    const p = t / J.hop;
    const x = home.x + (dest.x - home.x) * ease(p);
    // An arc: up about 8 px above the desk, then down to the prompt box.
    const y = home.y + (dest.y - home.y) * p * p - 8 * Math.sin(Math.PI * Math.min(1, p * 1.3));
    return { frame: 'open', x, y, done: false };
  }
  t -= J.hop;
  if (t < J.land) return { frame: 'half', x: dest.x, y: dest.y + 1, done: false };
  t -= J.land;
  if (t < J.settle) return { frame: 'closed', x: dest.x, y: dest.y, done: false };
  return { frame: 'open', x: dest.x, y: dest.y, done: true };
}
