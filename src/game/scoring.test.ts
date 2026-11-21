import { describe, expect, test } from "vitest";
import { hasScoringDice, scoreDice, type DieValue } from "./scoring";

const score = (...values: DieValue[]) => scoreDice(values);

describe("scoreDice", () => {
  test.each([
    [[1], 100],
    [[5], 50],
    [[1, 5], 150],
    [[1, 1], 200],
    [[1, 1, 1], 1000],
    [[2, 2, 2], 200],
    [[3, 3, 3], 300],
    [[6, 6, 6], 600],
    [[2, 2, 2, 2], 1000],
    [[2, 2, 2, 2, 2], 2000],
    [[2, 2, 2, 2, 2, 2], 3000],
    [[1, 2, 3, 4, 5, 6], 1500],
    [[2, 2, 3, 3, 4, 4], 1500],
    [[2, 2, 2, 2, 3, 3], 1500],
    [[2, 2, 2, 3, 3, 3], 2500],
    [[2, 2, 2, 1, 5], 350],
  ] as Array<[DieValue[], number]>)("%j scores %i", (values, expected) => {
    expect(scoreDice(values)).toBe(expected);
  });

  test("picks the highest grouping when several apply", () => {
    // Four 1s: 1000 (three 1s) + 100 beats 1000 (four of a kind).
    expect(score(1, 1, 1, 1)).toBe(1100);
    // Four 5s: four of a kind (1000) beats 500 + 50.
    expect(score(5, 5, 5, 5)).toBe(1000);
    // Six 1s: six of a kind (3000) beats two sets of three 1s (2000).
    expect(score(1, 1, 1, 1, 1, 1)).toBe(3000);
    // Three pairs including 1s and 5s: 1500 beats 200 + 100.
    expect(score(1, 1, 5, 5, 3, 3)).toBe(1500);
  });

  test("rejects selections containing a die that doesn't score", () => {
    expect(score()).toBeNull();
    expect(score(2)).toBeNull();
    expect(score(1, 2)).toBeNull();
    expect(score(3, 3)).toBeNull();
    expect(score(2, 2, 2, 3)).toBeNull();
    // A straight only counts with all six dice.
    expect(score(1, 2, 3, 4, 5)).toBeNull();
    // Three pairs only counts with all six dice.
    expect(score(2, 2, 3, 3)).toBeNull();
  });
});

describe("hasScoringDice", () => {
  test("finds singles and triples", () => {
    expect(hasScoringDice([2, 3, 4, 6, 1])).toBe(true);
    expect(hasScoringDice([5])).toBe(true);
    expect(hasScoringDice([4, 4, 4, 2])).toBe(true);
  });

  test("finds six-dice combos with no 1s or 5s", () => {
    expect(hasScoringDice([2, 2, 3, 3, 4, 4])).toBe(true);
  });

  test("detects a farkle", () => {
    expect(hasScoringDice([2, 3, 4, 6])).toBe(false);
    expect(hasScoringDice([2, 2, 3, 3])).toBe(false);
    expect(hasScoringDice([6])).toBe(false);
  });
});
