# ZEDGE round keeper. Build from the repository root, which is the build context:
#
#   docker build -f services/keeper/Dockerfile -t zedge-keeper .
#
# The image holds the keeper, the contract ABIs, the public deployment records and the production dependencies of
# the root lockfile. It holds no secret and takes no build argument: the secrets file is mounted when the container
# starts, and Dockerfile.dockerignore next to this file keeps everything else in the repository out of the context.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY contracts/abi/*.json contracts/abi/
COPY contracts/deployment/hybrid-mainnet.json contracts/deployment/mainnet-addresses.json contracts/deployment/
# The test suite's two fixtures, so the image can prove itself on the host that will run it (see README).
COPY research/chainlink-streams-base.md research/
COPY services/keeper/*.mjs services/keeper/solana-fixtures.json services/keeper/
# The journal lives on a volume owned by the unprivileged user the keeper runs as (uid 1000).
RUN install -d -o node -g node -m 700 /state
USER node
VOLUME /state
ENTRYPOINT ["node", "services/keeper/main.mjs"]
CMD ["--watch", "--secrets", "/run/secrets/keeper.env", "--state-directory", "/state"]
