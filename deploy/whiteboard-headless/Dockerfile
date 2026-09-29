FROM node:24.11.0-bookworm-slim

COPY .build/review.tgz /tmp/review.tgz
COPY .build/diffr /usr/local/bin/diffr
RUN chmod 0755 /usr/local/bin/diffr \
    && npm install --global --omit=dev /tmp/review.tgz \
    && rm /tmp/review.tgz

USER node
ENTRYPOINT ["whiteboard"]
