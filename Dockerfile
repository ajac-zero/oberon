FROM node:24-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl \
	&& rm -rf /var/lib/apt/lists/*

# Amp CLI, pinned at build time. Rebuild to update; pass --build-arg AMP_VERSION=… to pin a release.
ARG AMP_VERSION=
RUN curl -fsSL https://ampcode.com/install.sh | AMP_HOME=/opt/amp AMP_VERSION="$AMP_VERSION" bash \
	&& ln -sf /opt/amp/bin/amp /usr/local/bin/amp \
	&& amp --version

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
	OBERON_HOST=0.0.0.0 \
	OBERON_PORT=8080 \
	OBERON_DATA_DIR=/data/oberon \
	HOME=/data/home \
	AMP_SKIP_UPDATE_CHECK=1

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
