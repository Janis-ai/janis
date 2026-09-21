# Janis agent template — reference BYOK agent.
#
# Build from the REPO ROOT (the template's @janis/* deps are workspace
# packages until they hit npm — esbuild bundles them into one file):
#
#   docker build -f packages/agent-template/Dockerfile -t janis-agent .
#   docker run -e JANIS_API_KEY=jk_live_... -p 9798:9798 janis-agent
#
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/sdk/package.json packages/sdk/
COPY packages/agent-template/package.json packages/agent-template/
RUN npm ci --no-audit --no-fund
COPY packages/shared packages/shared
COPY packages/sdk packages/sdk
COPY packages/agent-template packages/agent-template
RUN npm run build -w packages/shared && npm run build -w packages/sdk \
 && npx esbuild packages/agent-template/src/index.ts --bundle --platform=node \
    --format=esm --outfile=packages/agent-template/dist/agent.mjs

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/packages/agent-template/dist/agent.mjs agent.mjs
ENV PORT=9798
EXPOSE 9798
CMD ["node", "agent.mjs"]
