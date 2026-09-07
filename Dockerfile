# Bun's own image, pinned: an unpinned :latest turns a redeploy into a runtime change nobody asked
# for, and this process holds a key.
FROM oven/bun:1.3.14-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.14-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Never as root: this process fetches nothing and writes nothing, so it has no business being able
# to.
USER bun
EXPOSE 8790

# No healthcheck against a paid route — a prober that pays is a prober that costs money. The index
# is free and says which round is open, which is exactly what "is it alive" means here.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD bun -e "const r = await fetch('http://localhost:' + (process.env.PORT ?? 8790) + '/'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "run", "src/main.ts"]
