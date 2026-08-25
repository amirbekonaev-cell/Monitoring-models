FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/database/migrations ./src/database/migrations

# Vercel injects PORT; main.ts already reads it via ConfigService (config.get('port')).
# Migrations are NOT run here on purpose — see README "Деплой на Vercel": running them on every
# cold start would fire them concurrently from multiple serverless instances. Run
# `npm run migration:run` by hand against DATABASE_URL once per schema-changing release instead.
CMD ["node", "dist/main.js"]
