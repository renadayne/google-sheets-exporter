import type { ExtensionConfig } from '../types/config';

export interface ConfigEvaluation {
  isConfigured: boolean;
  errorCode?: string;
  message: string;
  clientId?: string;
}

/**
 * Evaluates whether the extension build has valid identity capability and configuration.
 * In offline unconfigured builds or when identity metadata (client ID, manifest public key, scopes)
 * is incomplete or missing, returns CONFIG_REQUIRED and marks isConfigured false.
 * Never treats placeholder or partial credentials as valid identity capabilities.
 */
export function evaluateConfig(config: Partial<ExtensionConfig> | null | undefined): ConfigEvaluation {
  const fallbackCode = config?.offlineBuild?.unconfiguredErrorCode || 'CONFIG_REQUIRED';

  if (!config || typeof config !== 'object' || !config.oauth2) {
    return {
      isConfigured: false,
      errorCode: fallbackCode,
      message: 'Extension configuration is missing or invalid.'
    };
  }

  const { clientId, manifestPublicKey, scopes } = config.oauth2;

  if (!clientId || typeof clientId !== 'string' || clientId.trim() === '') {
    return {
      isConfigured: false,
      errorCode: fallbackCode,
      message: 'OAuth client ID is not configured for this build.'
    };
  }

  if (!manifestPublicKey || typeof manifestPublicKey !== 'string' || manifestPublicKey.trim() === '') {
    return {
      isConfigured: false,
      errorCode: fallbackCode,
      message: 'Manifest public key (identity capability metadata) is not configured for this build.'
    };
  }

  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some(s => typeof s !== 'string' || !s.trim())) {
    return {
      isConfigured: false,
      errorCode: fallbackCode,
      message: 'OAuth scopes are not configured for this build.'
    };
  }

  return {
    isConfigured: true,
    clientId: clientId.trim(),
    message: 'Configuration is valid.'
  };
}
