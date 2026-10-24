# Stand-in "checkout" service for the demos. FAIL=true builds the broken release, which cannot reach its database.
FROM busybox:1.36
ARG VERSION=1.4.2
ARG FAIL=false
ENV VERSION=$VERSION FAIL=$FAIL DB_HOST=payments-db.shop.svc
CMD ["sh", "-c", "echo \"checkout $VERSION starting\"; if [ \"$FAIL\" = true ]; then echo \"ERROR payments-db:5432 connection refused (DB_HOST=$DB_HOST)\"; exit 1; fi; echo \"checkout $VERSION listening on :8080\"; while true; do sleep 3600; done"]
