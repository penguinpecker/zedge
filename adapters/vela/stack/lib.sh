# EVALUATION ONLY. Shared by up.sh, down.sh and run.sh. Software TEE, no
# attestation, test token, fixture oracle; sender, amount and time are trusted
# from the manager. Not private, not secure, not production-ready.
PROJECT=${ZEDGE_VELA_PROJECT:-zedgevela}
KIT_COMMIT=85529cb769cd07a0f89cb959ba62c334a9cf5a9f
KIT=build/vela-starterkit

# Everything this slice starts runs under one compose project, so it is stopped
# by that name and nothing else is touched.
compose() {
  docker compose -p "$PROJECT" --env-file "$KIT/dockerfiles/.env.dev" \
    -f "$KIT/dockerfiles/docker-compose.yml" -f compose.override.yml "$@"
}
