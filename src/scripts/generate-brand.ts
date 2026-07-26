import './offline-env';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderBrandAvatar, renderBrandBanner } from '../render/brand';

/**
 * Génère l'identité visuelle du bot dans `assets/brand/`.
 *
 *   npm run brand
 *
 * Ni base de données, ni Redis, ni token Discord : c'est du dessin pur.
 * Les tailles correspondent à ce que Discord attend :
 *   - avatar          512 × 512  (rogné en cercle à l'affichage)
 *   - bannière profil 680 × 240
 *   - icône serveur   256 × 256  (même dessin, sortie plus légère)
 */

async function main(): Promise<void> {
  const outDir = resolve(process.cwd(), 'assets/brand');
  mkdirSync(outDir, { recursive: true });

  const name = process.env.BRAND_NAME ?? 'HARVESTER';

  // La bannière par défaut est en ANGLAIS : Discord n'en accepte qu'une seule
  // par application, et elle est vue par tout le monde quelle que soit la langue
  // du joueur. L'anglais est le plus petit dénominateur commun. La variante
  // française reste disponible pour un serveur ou un site francophone.
  const taglineEn = process.env.BRAND_TAGLINE ?? 'Sow · Harvest · Prosper';
  const taglineFr = 'Semez · Récoltez · Prospérez';

  const files: Array<[string, Buffer]> = [
    ['harvester-avatar.png', await renderBrandAvatar(512)],
    ['harvester-avatar-256.png', await renderBrandAvatar(256)],
    ['harvester-banner.png', await renderBrandBanner(680, 240, { name, tagline: taglineEn })],
    ['harvester-banner-fr.png', await renderBrandBanner(680, 240, { name, tagline: taglineFr })],
  ];

  for (const [file, buffer] of files) {
    const path = resolve(outDir, file);
    writeFileSync(path, buffer);
    console.log(`✓ ${path}  (${(buffer.length / 1024).toFixed(1)} Ko)`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
