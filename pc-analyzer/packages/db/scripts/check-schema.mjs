// =============================================================================
//  Vérification du schéma : rejoue la migration et le seed dans PGlite
//  (PostgreSQL compilé en WebAssembly, aucun serveur à installer), puis
//  exécute quelques requêtes représentatives — dont la recherche d'alias par
//  similarité trigramme qui est au cœur du module de matching.
//
//    npm run db:check          (depuis pc-analyzer/)
// =============================================================================
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

async function sqlFiles(dir) {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  return Promise.all(names.map(async (n) => ({ name: n, sql: await readFile(path.join(dir, n), 'utf8') })));
}

const db = new PGlite({ extensions: { pg_trgm } });

for (const { name, sql } of await sqlFiles(path.join(root, 'migrations'))) {
  await db.exec(sql);
  console.log(`✔ migration ${name}`);
}
for (const { name, sql } of await sqlFiles(path.join(root, 'seed'))) {
  await db.exec(sql);
  console.log(`✔ seed ${name}`);
}

const tables = await db.query(
  `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
);
console.log(`tables : ${tables.rows[0].n}`);

// Matching : un titre marchand approximatif retrouve le bon composant.
const fuzzy = await db.query(
  `SELECT c.name, a.alias, round(similarity(a.alias_normalized, $1)::numeric, 2) AS sim
     FROM component_aliases a JOIN components c ON c.id = a.component_id
    WHERE a.alias_normalized % $1
    ORDER BY sim DESC LIMIT 3`,
  ['geforce rtx 4060 8go laptop'],
);
console.log('similarité trigramme pour « geforce rtx 4060 8go laptop » :');
for (const row of fuzzy.rows) console.log(`  ${row.sim}  ${row.name}  ←  « ${row.alias} »`);
if (!fuzzy.rows.length || !fuzzy.rows[0].name.includes('RTX 4060')) {
  throw new Error('Le matching trigramme ne retrouve pas la RTX 4060 Laptop');
}

// Vue moteur : un composant avec son support Linux et ses problèmes connus.
const view = await db.query(
  `SELECT name, status, kernel_min, driver_name, jsonb_array_length(known_issues) AS issues, gpu->>'perf_index' AS perf
     FROM components_with_linux WHERE canonical_name = 'amd radeon 890m'`,
);
console.log('components_with_linux :', view.rows[0]);
if (view.rows[0].status !== 'plug_and_play' || view.rows[0].kernel_min !== '6.10') {
  throw new Error('La vue components_with_linux ne renvoie pas les critères Linux attendus');
}

// Contrainte métier : une comparaison ne dépasse pas 4 PC.
let rejected = false;
try {
  await db.query(`INSERT INTO comparisons (share_slug, pc_ids) VALUES ('trop', ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()])`);
} catch {
  rejected = true;
}
if (!rejected) throw new Error('La contrainte « 4 PC maximum » n\'est pas appliquée');
console.log('✔ contrainte comparaisons ≤ 4 PC');

await db.close();
console.log('Schéma et seed valides.');
