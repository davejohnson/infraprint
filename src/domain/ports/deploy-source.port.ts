export interface DeploySourceCredentialProjectionRequest {
  /** Opaque credentials from the provider connection named by the projection. */
  credentials: unknown;
  /** Credential-free repository URL that the hosting provider will consume. */
  sourceRepoUrl: string;
}

export interface DeploySourceCredentialProjection {
  /** Registered connection provider whose credentials this projection consumes. */
  connectionProvider: string;
  /**
   * Project only the provider-owned internal variables needed to fetch source.
   * Returned values are secret deploy inputs and must never enter output,
   * receipts, desired state, or repository bindings.
   */
  projectEnvironmentVariables(
    request: DeploySourceCredentialProjectionRequest
  ): Record<string, string>;
}

/** Optional hosting capability for source-fetch credential projection. */
export interface IDeploySourceCredentialAdapter {
  readonly deploySourceCredentialProjection: DeploySourceCredentialProjection;
}

export function isDeploySourceCredentialAdapter(
  value: unknown
): value is IDeploySourceCredentialAdapter {
  if (typeof value !== 'object' || value === null) return false;
  const projection = (value as Record<string, unknown>).deploySourceCredentialProjection;
  if (typeof projection !== 'object' || projection === null) return false;
  const record = projection as Record<string, unknown>;
  return typeof record.connectionProvider === 'string'
    && record.connectionProvider.trim().length > 0
    && typeof record.projectEnvironmentVariables === 'function';
}
