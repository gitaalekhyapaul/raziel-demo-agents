FROM raziel-toolchain:m0
ARG AGENT_UID=1000
ARG AGENT_GID=1000
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
COPY vendor ./vendor
RUN pnpm install --frozen-lockfile --prod
COPY src ./src
COPY public ./public
RUN mkdir -p /var/lib/raziel-agent && chmod 0700 /var/lib/raziel-agent \
    && chown "${AGENT_UID}:${AGENT_GID}" /var/lib/raziel-agent
USER ${AGENT_UID}:${AGENT_GID}
ENV AGENT_STATE_DIR=/var/lib/raziel-agent HOST=0.0.0.0
CMD ["node", "src/server.ts"]
