/**
 * Compagnons de ferme : purement cosmétiques, aucune production ni bonus de
 * jeu — un habillage, pas un système à équilibrer. Débloqués par niveau, le
 * même axe de progression que tout le reste du jeu (pas de nouvelle monnaie
 * ni de nouvelle jauge à suivre).
 *
 * `name`/`description` restent en anglais brut ici, comme les gabarits
 * d'objectifs de coopérative (`game/coop.ts`) : jamais affichés tels quels,
 * l'affichage résout toujours le texte depuis `key` via `pets.catalog.<key>.*`
 * dans la langue du spectateur.
 */

export interface PetTemplate {
  key: string;
  name: string;
  description: string;
  emoji: string;
  unlockLevel: number;
}

export const PET_CATALOG: readonly PetTemplate[] = [
  { key: 'chick', name: 'Chick', description: 'Hatches alongside your very first harvests.', emoji: '🐤', unlockLevel: 1 },
  { key: 'kitten', name: 'Kitten', description: 'Naps in the sun between two waterings.', emoji: '🐱', unlockLevel: 5 },
  { key: 'puppy', name: 'Puppy', description: 'Runs along the rows of plots.', emoji: '🐶', unlockLevel: 10 },
  { key: 'piglet', name: 'Piglet', description: 'Always finds the muddiest plot.', emoji: '🐷', unlockLevel: 15 },
  { key: 'bunny', name: 'Bunny', description: 'Keeps a suspicious eye on the carrots.', emoji: '🐰', unlockLevel: 20 },
  { key: 'fox', name: 'Fox', description: 'Watches the hen house a little too closely.', emoji: '🦊', unlockLevel: 30 },
  { key: 'owl', name: 'Owl', description: 'Keeps watch over the farm at night.', emoji: '🦉', unlockLevel: 40 },
  { key: 'dragon', name: 'Baby dragon', description: 'A legend among farmhands.', emoji: '🐉', unlockLevel: 60 },
] as const;

export function findPet(key: string): PetTemplate | undefined {
  return PET_CATALOG.find((pet) => pet.key === key);
}

export function isPetUnlocked(key: string, level: number): boolean {
  const pet = findPet(key);
  return pet !== undefined && level >= pet.unlockLevel;
}

export function unlockedPetKeys(level: number): string[] {
  return PET_CATALOG.filter((pet) => level >= pet.unlockLevel).map((pet) => pet.key);
}
