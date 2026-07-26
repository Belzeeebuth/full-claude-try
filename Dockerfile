# =============================================================================
#  HarvestBot — image de production
#  Build multi-étapes : l'image finale ne contient ni sources TypeScript ni
#  dépendances de développement (~180 Mo au lieu de ~650 Mo).
# =============================================================================

# ---------- Étape 1 : dépendances de build ----------------------------------
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# ---------- Étape 2 : compilation -------------------------------------------
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm run test

# ---------- Étape 3 : dépendances de production seulement --------------------
FROM node:20-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---------- Étape 4 : image finale ------------------------------------------
FROM node:20-bookworm-slim AS runtime

# `fonts-noto-color-emoji` : @napi-rs/canvas dessine déjà tous les indicateurs
# critiques en vectoriel, mais cette police permet d'afficher de vrais emoji
# dans les images si vous en ajoutez. `fonts-dejavu-core` fournit une police
# texte par défaut fiable. `curl` sert au HEALTHCHECK.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        fonts-dejavu-core \
        fonts-noto-color-emoji \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TZ=Europe/Paris

WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY package.json ./
COPY assets ./assets

# Le process ne tourne jamais en root.
RUN useradd --system --create-home --uid 10001 harvest \
    && chown -R harvest:harvest /app
USER harvest

EXPOSE 3001

# Le healthcheck interroge /health, qui vérifie Discord ET PostgreSQL : un
# process vivant mais déconnecté est considéré malsain et sera redémarré.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3001/health || exit 1

# `dumb-init` n'est pas nécessaire : Node 20 gère correctement SIGTERM, et
# `src/index.ts` implémente un arrêt propre.
CMD ["node", "dist/index.js"]
