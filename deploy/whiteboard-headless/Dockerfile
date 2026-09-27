FROM node:24.11.0-bookworm-slim

COPY .build/review.tgz /tmp/review.tgz
RUN npm install --global --omit=dev /tmp/review.tgz \
    && rm /tmp/review.tgz

USER node
ENTRYPOINT ["whiteboard"]
