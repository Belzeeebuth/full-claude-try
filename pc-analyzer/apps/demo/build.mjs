// Construit la démo : un seul fichier JS (moteur + interface) et les fichiers
// statiques de public/ copiés tels quels. Chemins relatifs uniquement, pour que
// la page fonctionne sous n'importe quel sous-chemin (GitHub Pages).
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('./', import.meta.url));
const dist = `${here}dist/`;

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({
  entryPoints: [`${here}src/main.ts`],
  bundle: true,
  minify: true,
  format: 'esm',
  target: ['es2020'],
  outfile: `${dist}main.js`,
  legalComments: 'none',
  logLevel: 'info',
});
await cp(`${here}public/`, dist, { recursive: true });
console.log(`démo construite dans ${dist}`);
