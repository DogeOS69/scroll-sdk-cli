FROM ghcr.io/celestiaorg/celestia-app:v6.4.10 AS celestia-app

FROM ghcr.io/celestiaorg/celestia-node:v0.28.4

USER root

RUN apk --no-cache add curl jq bash \
    && mkdir -p /bridge \
    && chown -R celestia:celestia /bridge /home/celestia

USER celestia

COPY --from=celestia-app /bin/celestia-appd /bin/

COPY entrypoint.sh /opt/entrypoint.sh

EXPOSE 26657 26658 26659 9090

ENTRYPOINT ["/bin/bash", "/opt/entrypoint.sh"]
