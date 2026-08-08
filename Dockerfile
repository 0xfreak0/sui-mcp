# Container image for the MCP server. Glama and similar directories build this
# to introspect the tool list; it is not how most people run the server (that is
# `npx sui-analytics-mcp`), but it has to work standalone.
#
# The server speaks MCP over **stdio**, not a port. There is nothing to EXPOSE,
# and a client must attach to the container's stdin/stdout:
#
#   docker run -i --rm sui-analytics-mcp
#
# `-i` is load-bearing. Without it stdin is closed, the transport sees EOF and
# the server exits immediately, which looks like a crash.

# 0 = fast build, 56 of 57 tools. 1 also builds the Move decompiler, which takes
# tens of minutes. Declared here, above the first FROM, because an ARG used in a
# FROM line must live in the global scope — declared later it expands to empty
# and the build dies on `invalid reference format`.
#
#   docker build --build-arg WITH_DECOMPILER=1 -t sui-analytics-mcp .
ARG WITH_DECOMPILER=0

# Revela, the Move decompiler behind `decompile_module`. This is the one tool
# that needs a binary the npm package cannot ship, so a clone install leaves it
# unavailable until you run `npm run build:decompiler` yourself. An image can
# carry it, which is the main thing the container offers over `npx`.
#
# It is a Rust build over the Move crates and is SLOW — tens of minutes on a
# cold cache, and the heaviest part of building this image by far. It is its own
# stage so the cost is paid once and cached, and so only the ~30MB binary
# reaches the runtime layer rather than the whole Rust toolchain.
FROM rust:1-slim AS decompiler

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates pkg-config libssl-dev \
 && rm -rf /var/lib/apt/lists/*

# --depth 1: the build needs the tree, not the history.
RUN git clone --depth 1 https://github.com/verichains/revela_sui.git /src
WORKDIR /src/external-crates/move
RUN cargo build --release --bin move-decompiler


# 22.13 is the floor, not a preference: node:sqlite (which backs the optional
# store) stopped needing a flag in 22.13, and package.json declares >=22.13.0.
# Node 20 reached EOL 2026-04-30 and cannot run this at all.
FROM node:22.13-slim AS build

WORKDIR /app

# Dependencies first so the layer caches across source edits.
COPY package.json package-lock.json ./
# --ignore-scripts matches the release workflow: nothing this project depends on
# needs an install script, so running them only widens the supply-chain surface.
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
# `npm run build` runs tsc and copies src/data into dist/. Those JSON files (the
# token and protocol registries) are read at runtime, so a dist/ without them
# builds clean and then fails on first lookup.
RUN npm run build


# Runtime stage: ships dist/ and production dependencies only — no toolchain,
# no source, no devDependencies.
FROM node:22.13-slim AS runtime-base

WORKDIR /app
ENV NODE_ENV=production

# Load every tool by default, which is the opposite of the npx default (`core`,
# 18 tools). Directories build this image and run tools/list to record what the
# server can do, and that record is public and sticky — an unset SUI_TOOLS would
# publish 18 tools as the server's declared capability surface. Anyone who wants
# the smaller, cheaper surface overrides it: `docker run -i -e SUI_TOOLS=core`.
ENV SUI_TOOLS=all

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist


# Two finishes, selected by WITH_DECOMPILER below.
#
# BuildKit only builds stages the selected target actually depends on, so the
# default never touches the Rust stage — it is not skipped quickly, it is not
# entered at all. That is the whole point: the decompiler build takes tens of
# minutes over the Move crates, and directory sandboxes that build this image
# have build timeouts. A timeout means no image, which means no introspection
# and a listing that reads "cannot be installed" — losing all 57 tools to keep
# one. Defaulting off trades `decompile_module` for a build that finishes.
FROM runtime-base AS runtime-0

# Opt in with: docker build --build-arg WITH_DECOMPILER=1 -t sui-analytics-mcp .
# On PATH, so config.ts's default (`move-decompiler`, resolved via PATH) finds
# it with no SUI_DECOMPILER_PATH set.
FROM runtime-base AS runtime-1
COPY --from=decompiler /src/external-crates/move/target/release/move-decompiler /usr/local/bin/move-decompiler

FROM runtime-${WITH_DECOMPILER} AS runtime

# Drop root. The server only makes outbound HTTPS calls and reads its own files,
# so it never needs privilege. `node` is a non-root user the base image provides.
USER node

# No ENTRYPOINT wrapper: the process must own stdin/stdout for the stdio
# transport, and a shell in between can buffer or mangle the JSON-RPC stream.
CMD ["node", "dist/index.js"]
