# ZEDGE Node services on Railway: house-bot, payout-signer, keeper. One image; ZEDGE_SERVICE picks the service.
# Build context: a `git archive HEAD` export of the repository root (no key, .env or untracked file can be in it).
FROM node:22.22.2-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY adapters/vela/crypto/package.json adapters/vela/crypto/package-lock.json adapters/vela/crypto/
RUN npm ci --omit=dev --ignore-scripts --prefix adapters/vela/crypto && npm cache clean --force
COPY adapters/vela/crypto/ adapters/vela/crypto/
COPY src/chain/ src/chain/
COPY services/ services/
COPY contracts/abi/ contracts/abi/
COPY contracts/deployment/ contracts/deployment/
COPY public/deployments/ public/deployments/
COPY deploy/railway/start.sh deploy/railway/
ENTRYPOINT ["/bin/sh", "deploy/railway/start.sh"]
