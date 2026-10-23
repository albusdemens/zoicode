import chalk from 'chalk';

/** Stardew Valley–inspired palette: wood, parchment, crops and gold. */
export const C = {
  wood: '#8B5A2B',
  woodDark: '#5C3A1A',
  woodLight: '#C08040',
  parchment: '#F5DEB3',
  gold: '#F7C548',
  goldLight: '#FFE680',
  goldDark: '#D08A1E',
  copper: '#B5562A',
  grass: '#7BC043',
  grassDark: '#4E8A2A',
  sky: '#6EC1F0',
  berry: '#D9466A',
  purple: '#A06CD5',
  stone: '#9A8F86',
  dim: '#8C7A6B',
};

export const paint = {
  wood: chalk.hex(C.wood),
  woodLight: chalk.hex(C.woodLight),
  parchment: chalk.hex(C.parchment),
  gold: chalk.hex(C.gold),
  grass: chalk.hex(C.grass),
  sky: chalk.hex(C.sky),
  berry: chalk.hex(C.berry),
  purple: chalk.hex(C.purple),
  stone: chalk.hex(C.stone),
  dim: chalk.hex(C.dim),
};

/** Map today's date onto a Stardew-style calendar: 4 seasons of 28 days. */
export function farmDate(d = new Date()): { season: string; icon: string; day: number } {
  const seasons = [
    { season: 'Winter', icon: '❄' }, { season: 'Spring', icon: '✿' },
    { season: 'Summer', icon: '☀' }, { season: 'Fall', icon: '🍂' },
  ];
  const s = seasons[Math.floor(((d.getMonth() + 1) % 12) / 3)];
  return { ...s, day: Math.min(28, d.getDate()) };
}

export function farmClock(d = new Date()): string {
  const h = d.getHours();
  const m = Math.floor(d.getMinutes() / 10) * 10;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
}

export const SPINNER_VERBS = [
  'Planting', 'Watering', 'Tilling', 'Foraging', 'Harvesting', 'Fishing for bugs', 'Mining for answers',
  'Feeding the chickens', 'Brewing coffee', 'Petting the dog', 'Chopping wood', 'Milking the cows',
  'Picking parsnips', 'Fertilizing', 'Crafting', 'Smelting', 'Composting', 'Herding goats',
  'Shearing sheep', 'Pickling', 'Sprinkling', 'Daydreaming by the river',
];

/** Crop growth stages, used as the thinking spinner. */
export const SPINNER_FRAMES = ['·', '⁘', '✢', '✿', '❀', '✿', '✢', '⁘'];
