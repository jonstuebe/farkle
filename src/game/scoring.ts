export type DieValue = 1 | 2 | 3 | 4 | 5 | 6;

export const DICE_COUNT = 6;

/** Point values for every scoring combination. Plain data, so it can live in machine context. */
export interface ScoringTable {
  singleOne: number;
  singleFive: number;
  /** Three 1s. */
  threeOnes: number;
  /** Three of any other face scores `face * threeOfAKindMultiplier`. */
  threeOfAKindMultiplier: number;
  fourOfAKind: number;
  fiveOfAKind: number;
  sixOfAKind: number;
  /** The following only count when all six dice are used. */
  straight: number;
  threePairs: number;
  fourOfAKindAndPair: number;
  twoTriplets: number;
}

export const DEFAULT_SCORING: ScoringTable = {
  singleOne: 100,
  singleFive: 50,
  threeOnes: 1000,
  threeOfAKindMultiplier: 100,
  fourOfAKind: 1000,
  fiveOfAKind: 2000,
  sixOfAKind: 3000,
  straight: 1500,
  threePairs: 1500,
  fourOfAKindAndPair: 1500,
  twoTriplets: 2500,
};

type Counts = [number, number, number, number, number, number, number]; // index 0 unused

function countFaces(values: readonly DieValue[]): Counts {
  const counts: Counts = [0, 0, 0, 0, 0, 0, 0];
  for (const v of values) counts[v]++;
  return counts;
}

/** Score for combinations that need exactly six dice, or null if none apply. */
function sixDiceComboScore(counts: Counts, table: ScoringTable): number | null {
  const groups = counts.slice(1).filter((n) => n > 0).sort((a, b) => b - a);
  const shape = groups.join(",");
  let best: number | null = null;
  const consider = (points: number) => {
    best = best === null ? points : Math.max(best, points);
  };
  if (shape === "1,1,1,1,1,1") consider(table.straight);
  if (shape === "2,2,2") consider(table.threePairs);
  if (shape === "4,2") consider(table.fourOfAKindAndPair);
  if (shape === "3,3") consider(table.twoTriplets);
  return best;
}

function ofAKindScore(face: DieValue, n: number, table: ScoringTable): number {
  switch (n) {
    case 3:
      return face === 1 ? table.threeOnes : face * table.threeOfAKindMultiplier;
    case 4:
      return table.fourOfAKind;
    case 5:
      return table.fiveOfAKind;
    default:
      return table.sixOfAKind;
  }
}

/**
 * Best score for groups of a single face (singles and n-of-a-kind) that uses every die,
 * or null if some die can't score.
 */
function bestGroupedScore(counts: Counts, table: ScoringTable): number | null {
  const face = counts.findIndex((n, i) => i > 0 && n > 0);
  if (face === -1) return 0;
  const f = face as DieValue;
  const available = counts[f];

  // The lowest remaining face must belong to some group; try each option for it.
  const options: Array<{ use: number; points: number }> = [];
  if (f === 1) options.push({ use: 1, points: table.singleOne });
  if (f === 5) options.push({ use: 1, points: table.singleFive });
  for (let n = 3; n <= available; n++) options.push({ use: n, points: ofAKindScore(f, n, table) });

  let best: number | null = null;
  for (const { use, points } of options) {
    const rest = [...counts] as Counts;
    rest[f] -= use;
    const sub = bestGroupedScore(rest, table);
    if (sub !== null) best = Math.max(best ?? 0, points + sub);
  }
  return best;
}

/**
 * Score a set of dice the player wants to keep. Every die must contribute to a scoring
 * combination; returns null when the selection is empty or contains a non-scoring die.
 * When dice can be grouped more than one way, the highest-scoring grouping wins.
 */
export function scoreDice(values: readonly DieValue[], table: ScoringTable = DEFAULT_SCORING): number | null {
  if (values.length === 0) return null;
  const counts = countFaces(values);
  const grouped = bestGroupedScore(counts, table);
  const sixCombo = values.length === DICE_COUNT ? sixDiceComboScore(counts, table) : null;
  if (grouped === null) return sixCombo;
  if (sixCombo === null) return grouped;
  return Math.max(grouped, sixCombo);
}

/** True if at least one die (or combination) in the roll scores. False means a farkle. */
export function hasScoringDice(values: readonly DieValue[], table: ScoringTable = DEFAULT_SCORING): boolean {
  const counts = countFaces(values);
  if (counts[1] > 0 || counts[5] > 0) return true;
  if (counts.some((n, i) => i > 0 && n >= 3)) return true;
  return values.length === DICE_COUNT && sixDiceComboScore(counts, table) !== null;
}
