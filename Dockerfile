# 用 Debian slim 而不是 Alpine：better-sqlite3 与 @napi-rs/canvas 的预编译
# 二进制是 glibc 的，Alpine（musl）下要现场编译，镜像更大也更容易出问题。
FROM node:22-bookworm-slim AS base
# 分两行写：同一条 ENV 里 $PNPM_HOME 还没生效
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# corepack 按 package.json 的 packageManager 字段取 pnpm 版本，
# 和本地完全一致——不钉住的话容器会拉最新版 pnpm，其默认的
# minimumReleaseAge 策略会拒掉刚发布不久的依赖，构建随机失败
RUN corepack enable

# ── 构建层：装依赖并打前端 ────────────────────────────────────────
FROM base AS build
WORKDIR /app

# better-sqlite3 在部分平台（如 linux/arm64）没有预编译产物，会退回
# node-gyp 源码编译，需要 python3 + 编译器。只装在构建层：
# 编译出来的 .node 随 /app 一起搬进运行层，运行层不需要工具链。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
# 先只拷清单，依赖没变时这一层复用缓存
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/drill-schema/package.json packages/drill-schema/
COPY packages/drill-engine/package.json packages/drill-engine/
COPY packages/drill-render/package.json packages/drill-render/
COPY packages/drill-ai/package.json packages/drill-ai/
COPY packages/drill-export/package.json packages/drill-export/
COPY packages/drill-tts/package.json packages/drill-tts/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ── 运行层 ────────────────────────────────────────────────────────
FROM base AS runtime
WORKDIR /app

# ffmpeg 编码 MP4 与混配音；Noto CJK 是中文字体，
# 没有它导出的说明文字会变成方框（启动日志会明确报出来）
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*

# 整个 /app 从构建层原样搬过来：pnpm workspace 在 node_modules 里布了大量
# 指向 ../../packages 的符号链接，分开拷很容易把链接拷断。
# 代价是带上了 dev 依赖（服务端用 tsx 直接跑 TS，tsx 本身就是 dev 依赖）。
COPY --from=build /app /app

ENV NODE_ENV=production
# 前端产物由服务端一起托管，只开一个端口（同源，也是 PWA 的前提）
ENV WEB_DIST=/app/apps/web/dist
# 数据全部落在 /data，compose 里挂成卷
ENV DB_PATH=/data/drills.db
ENV EXPORT_DIR=/data/exports
ENV TTS_CACHE_DIR=/data/tts-cache
ENV PORT=8787

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "--filter", "@drill/server", "start"]
