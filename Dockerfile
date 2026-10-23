# K8sCortex MCP server image. Default command serves HTTP (Streamable HTTP + SSE) on $PORT;
# run `node dist/stdio.js` with `docker run -i` for a stdio session.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
LABEL org.opencontainers.image.title="K8sCortex MCP" \
      org.opencontainers.image.description="Governed multi-cloud Kubernetes MCP server" \
      org.opencontainers.image.source="https://github.com/apatilgtn/k8scortex-mcp" \
      org.opencontainers.image.licenses="MIT" \
      io.modelcontextprotocol.server.name="io.github.apatilgtn/k8scortex-mcp"
CMD ["node", "dist/index.js"]
