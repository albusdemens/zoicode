import chalk from 'chalk';

/** The palette: warm wood, cream and gold, with green and berry accents. */
export const C = {
  wood: '#8B5A2B',
  woodDark: '#5C3A1A',
  woodLight: '#C08040',
  parchment: '#F5DEB3',
  gold: '#F7C548',
  goldLight: '#FFE680',
  grass: '#7BC043',
  sky: '#6EC1F0',
  berry: '#D9466A',
  purple: '#A06CD5',
  stone: '#9A8F86',
  dim: '#8C7A6B',
};

export const paint = {
  wood: chalk.hex(C.wood),
  gold: chalk.hex(C.gold),
  grass: chalk.hex(C.grass),
  dim: chalk.hex(C.dim),
};

export const SPINNER_VERBS = [
  'Thinking', 'Pondering', 'Purring', 'Tinkering', 'Brewing coffee', 'Untangling yarn', 'Chasing bugs',
  'Kneading the code', 'Sniffing around', 'Scheming', 'Doodling', 'Batting at bugs', 'Stretching',
  'Mulling it over', 'Connecting the dots', 'Polishing', 'Napping on the keyboard', 'Chasing the cursor',
];

/** A flower opening and closing: the thinking spinner. */
export const SPINNER_FRAMES = ['·', '⁘', '✢', '✿', '❀', '✿', '✢', '⁘'];
