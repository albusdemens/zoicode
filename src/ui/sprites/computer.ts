import type { SpriteSheet } from './types.js';

/** The retro computer on the desk. Its screen is the rectangle of `S` pixels, drawn over by scene.ts. */
export const computer: SpriteSheet = {
  name: 'computer',
  width: 34,
  height: 24,
  palette: {
    O: '#7F7466', // monitor outline (warm taupe frame)
    H: '#F6F4F0', // bezel highlight
    M: '#DDD8D0', // bezel, light warm gray
    m: '#C4BDB2', // chin shade
    c: '#8F877B', // webcam
    L: '#7FD18A', // power led
    S: '#EAF1F8', // screen (code draws here)
    D: '#56524D', // stand
    o: '#6B645B', // keyboard outline
    Q: '#A39C91', // keyboard base
    q: '#8A8379', // keyboard front face
    K: '#F5F3EF', // keycap top
    J: '#D6D2CB', // keycap lower half
    k: '#7E8796', // keycap chrome rim
    G: '#D6AE4E', // gold rivet
  },
  frames: {
    main: [
      '..OOOOOOOOOOOOOOOOOOOOOOOOOOOOOO..',
      '.OHHHHHHHHHHHHHHccHHHHHHHHHHHHHHO.',
      'OMSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSMO',
      'OMSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSMO',
      'OMSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSMO',
      'OMSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSMO',
      'OMSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSMO',
      'OMSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSMO',
      'OMSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSMO',
      'OMSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSMO',
      'OMSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSMO',
      'OMSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSMO',
      'OMSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSMO',
      'OMSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSMO',
      'OMMMMMMMMMMMMMMMMMMMMMMMMMMMMLMMMO',
      '.OmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmO.',
      '..OOOOOOOOODDDDDDDDDDDDOOOOOOOOO..',
      '..........DDDDDDDDDDDDDD..........',
      '..oooooooooooooooooooooooooooooo..',
      '.oQQKKQKKQKKQKKQKKQKKQKKQKKQKKQQo.',
      '.oQQkkGkkGkkGkkGkkGkkGkkGkkGkkQQo.',
      '.oQKKQKKQKKQKKQKKQKKQKKQKKQKKQKKo.',
      '.oQkkGkkGkkGkkGkkGkkGkkGkkGkkGkko.',
      '..oooooooooooooooooooooooooooooo..',
    ],
  },
};
