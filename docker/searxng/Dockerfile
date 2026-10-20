FROM docker.io/searxng/searxng:latest
# Python auth proxy fronts SearXNG — Cloud Run IAM invoker isn't enforced
# on this project, so the shared-secret check happens at the container edge.
COPY settings.yml /etc/searxng/settings.yml
COPY auth-proxy.py start.sh /app/
RUN chmod +x /app/start.sh
EXPOSE 8080
ENTRYPOINT ["/app/start.sh"]
