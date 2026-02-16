FROM ghcr.io/celestiaorg/celestia-app:v3.4.1 AS celestia-app

FROM ghcr.io/celestiaorg/celestia-node:v0.20.4

USER root

RUN apk --no-cache add curl jq bash \
    && mkdir -p /bridge \
    && chown celestia:celestia /bridge

USER celestia

COPY --from=celestia-app /bin/celestia-appd /bin/

COPY entrypoint.sh /opt/entrypoint.sh

EXPOSE 26657 26658 26659 9090

ENTRYPOINT ["/bin/bash", "/opt/entrypoint.sh"]
