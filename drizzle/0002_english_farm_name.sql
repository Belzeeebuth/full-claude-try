-- Nom de ferme par défaut en anglais.
--
-- L'interface est passée à l'anglais, mais le nom de ferme est une VALEUR
-- STOCKÉE : changer le défaut dans le schéma ne touche pas les lignes déjà
-- écrites. Les fermes créées avant cette migration s'appellent donc encore
-- « Ma ferme », et c'est ce nom-là que /farm affiche.
--
-- On renomme uniquement les fermes portant le défaut historique : un joueur
-- ayant choisi son propre nom le conserve.

ALTER TABLE farms ALTER COLUMN name SET DEFAULT 'My farm';
--> statement-breakpoint

UPDATE farms SET name = 'My farm' WHERE name = 'Ma ferme';
