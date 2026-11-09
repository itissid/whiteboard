FROM node:24.11.0-bookworm-slim

COPY .build/review.tgz /tmp/review.tgz
COPY .build/diffr /usr/local/bin/diffr
RUN chmod 0755 /usr/local/bin/diffr \
    && apt-get update \
    && apt-get install --yes --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --omit=dev /tmp/review.tgz \
    && rm /tmp/review.tgz

USER node
ENTRYPOINT ["whiteboard"]
