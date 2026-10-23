FROM --platform=${BUILDPLATFORM} oven/bun:latest
ARG TARGETPLATFORM
ARG TARGETARCH
ARG TARGETVARIANT
ARG GH_PACKAGES_TOKEN
# Build information
RUN printf "I'm building for TARGETPLATFORM=${TARGETPLATFORM}" \
    && printf ", TARGETARCH=${TARGETARCH}" \
    && printf ", TARGETVARIANT=${TARGETVARIANT} \n" \
    && printf "With uname -s : " && uname -s \
    && printf "and  uname -m : " && uname -m

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Create non-root user for security
RUN groupadd -g 1001 appuser && \
    useradd -r -u 1001 -g appuser appuser

# Copy package files first for better caching.
#
# Every one of these is optional except package.json, and the trailing `*` is
# what says so: a COPY whose glob matches nothing succeeds, while a bare name
# that is absent fails the build. `bunfig.toml` learned that the hard way — it
# held only `[test] preload`, which is Bun test-runner config that never ran
# because the test script is vitest, so it was deleted as dead config and this
# line failed the image build on the next push.
COPY package.json bun.lock* bunfig.toml* ./

# Setup npm authentication for private packages
RUN echo "@sudobility:registry=https://npm.pkg.github.com" > ~/.npmrc && \
    echo "//npm.pkg.github.com/:_authToken=${GH_PACKAGES_TOKEN}" >> ~/.npmrc

# Install dependencies
RUN bun install --production && \
    rm -f ~/.npmrc

# Copy source code
COPY . .

# Create logs directory and set permissions
RUN mkdir -p /app/logs && \
    chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 8025

# Health check
HEALTHCHECK --interval=30s --timeout=15s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:${PORT:-8025}/health || exit 1

# Use dumb-init as process manager
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Start the API server
CMD ["bun", "run", "start"]
