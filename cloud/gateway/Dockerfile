FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.cjs ./
USER node
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
CMD ["node", "server.cjs"]
