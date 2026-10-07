# Horizen's Vela manager v0.2.1-snapshot1 (same digest as the mainnet recipe's compose.yml, binary unmodified) plus rpcguard in the
# same container, so the two only ever stop together, and always by SIGKILL (manager-start.sh). The vela-* helpers move the
# database onto the volume over `railway ssh` one word at a time and print only counts and hashes, never contents.
FROM horizen/cce-manager@sha256:37fb2b6a2bba70b162d688f165f0558753aaef9838124a0ae373dbdb46245c4e
RUN apk add --no-cache nodejs
COPY deploy/railway/vela/rpcguard.mjs /guard/rpcguard.mjs
COPY deploy/railway/vela/manager-start.sh /manager-start.sh
COPY deploy/railway/vela/helpers/ /usr/local/bin/
RUN chmod 755 /usr/local/bin/vela-*
ENTRYPOINT ["/bin/sh", "/manager-start.sh"]
CMD []
