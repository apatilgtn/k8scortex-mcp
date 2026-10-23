# VHS with Node.js, for rendering the README demo (see README.md in this folder)
FROM node:22-slim AS node
FROM ghcr.io/charmbracelet/vhs:v0.9.0
COPY --from=node /usr/local/bin/node /usr/local/bin/node
