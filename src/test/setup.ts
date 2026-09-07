process.env.HYPERVIBE_DISABLE_REPO_SPEC ??= '1';
// Synthetic projects must not discover a developer's real repository .env.
// Env-file contract tests explicitly re-enable this boundary or pass a temp file.
process.env.HYPERVIBE_DISABLE_IMPLICIT_DEPLOY_ENV_FILE ??= '1';
// Ordinary tests must never create or chmod the developer's real
// ~/.hypervibe key. Security-specific tests explicitly unset this value and
// point HYPERVIBE_DATA_DIR at their own temporary directory.
process.env.HYPERVIBE_SECRET_KEY ??= '00'.repeat(32);
