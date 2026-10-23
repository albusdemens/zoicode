import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { useCatFrame, type CatMood } from './catAnim.js';
import { renderGrid } from './pixels.js';
import { PET_MARGIN } from './scene.js';
import { CAT_W, cat, sheetGrid } from './sprites/index.js';
import { C } from './theme.js';

/** The cat sitting on top of the prompt box, at the bottom right. */
export function CatCompanion({ mood }: { mood: CatMood }) {
  const frame = useCatFrame(mood);
  const lines = useMemo(() => renderGrid(sheetGrid(cat, frame)), [frame]);
  return (
    <Box flexDirection="column" flexShrink={0} width={CAT_W} marginRight={PET_MARGIN}>
      {lines.map((l, i) => (
        <Text key={i}>{l}</Text>
      ))}
    </Box>
  );
}

/** A speech bubble whose tail points right, toward the cat. */
export function Bubble({ text }: { text: string }) {
  return (
    <Box alignItems="flex-end">
      <Box borderStyle="round" borderColor={C.parchment} paddingX={1}>
        <Text color={C.parchment}>{text}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={C.parchment}>▸</Text>
      </Box>
    </Box>
  );
}

/** What the cat says, by occasion. */
export const CAT_LINES = {
  greet: ['Mrrp! Ready when you are.', 'Meow! Let’s write some code.', '*stretches* Hi there!'],
  permission: ['Mrrow? Your call.', '*tilts head*', 'Can I? Can I?'],
  plan: ['*sniffs the plan*', 'Ooh, a plan!', 'Purr… looks tasty.'],
  allowed: ['*happy tail flick*', 'Mrrp!', 'On it!'],
  denied: ['*flattens ears*', 'Okay… 😿', 'Fair enough.'],
  done: ['Purrr ✓', '*slow blink*', 'All done!', 'Nap time? 💤'],
  error: ['Hss… that broke.', '*puffs up*', 'Uh oh… 😿'],
  interrupted: ['*freezes*', 'Okay, stopping!', '*sits very still*'],
  pet: ['Purrrr ♥', '*headbutts your hand*', '*slow blink* ♥', '*rolls over*'],
};

export function pickLine(lines: string[]): string {
  return lines[Math.floor(Math.random() * lines.length)];
}
