/**
 * Names for accounts nobody named: `<noun>-<noun>-<1..10>`, like `otter-harbor-4`.
 * The migration that created the first accounts used the same words.
 */
export const ACCOUNT_NOUNS = [
  'acorn', 'anchor', 'arrow', 'badger', 'basil', 'beacon', 'birch', 'canyon', 'cedar', 'comet',
  'coral', 'crane', 'delta', 'ember', 'falcon', 'fern', 'glacier', 'harbor', 'heron', 'island',
  'jasper', 'juniper', 'kestrel', 'lantern', 'lotus', 'maple', 'marble', 'meadow', 'nickel', 'oak',
  'orbit', 'otter', 'pebble', 'pine', 'quartz', 'raven', 'reef', 'river', 'saffron', 'sparrow',
  'summit', 'thistle', 'timber', 'tulip', 'valley', 'walnut', 'willow', 'zephyr',
] as const

export function randomAccountName(random: () => number = Math.random): string {
  const pick = (): string => ACCOUNT_NOUNS[Math.floor(random() * ACCOUNT_NOUNS.length)] ?? 'oak'
  return `${pick()}-${pick()}-${1 + Math.floor(random() * 10)}`
}
