import { describe, it, expect } from 'vitest';
import { evaluateConfig } from '../../src/ui/config-state.ts';
import exampleConfig from '../../config/extension.example.json' with { type: 'json' };
import type { ExtensionConfig } from '../../src/types/config.d.ts';

describe('OAuth Configuration and Offline State Evaluation', () => {
  it('reads config/extension.example.json public template correctly', () => {
    expect(exampleConfig.oauth2.clientId).toBeNull();
    expect(exampleConfig.oauth2.manifestPublicKey).toBeNull();
    expect(exampleConfig.offlineBuild.omitOAuthMetadataWhenUnconfigured).toBe(true);
    expect(exampleConfig.offlineBuild.unconfiguredErrorCode).toBe('CONFIG_REQUIRED');
  });

  it('evaluates example configuration as unconfigured with CONFIG_REQUIRED', () => {
    const result = evaluateConfig(exampleConfig as ExtensionConfig);
    expect(result.isConfigured).toBe(false);
    expect(result.errorCode).toBe('CONFIG_REQUIRED');
    expect(result.clientId).toBeUndefined();
  });

  it('rejects null, empty string, or whitespace clientId without throwing', () => {
    const nullConfig: ExtensionConfig = {
      ...exampleConfig,
      oauth2: { ...exampleConfig.oauth2, clientId: null }
    };
    expect(evaluateConfig(nullConfig).isConfigured).toBe(false);

    const emptyConfig: ExtensionConfig = {
      ...exampleConfig,
      oauth2: { ...exampleConfig.oauth2, clientId: '   ' }
    };
    expect(evaluateConfig(emptyConfig).isConfigured).toBe(false);
  });

  it('rejects configuration when manifest public key is missing or empty', () => {
    const missingKeyConfig: ExtensionConfig = {
      ...exampleConfig,
      oauth2: {
        ...exampleConfig.oauth2,
        clientId: '123456789.apps.googleusercontent.com',
        manifestPublicKey: null
      }
    };
    const result = evaluateConfig(missingKeyConfig);
    expect(result.isConfigured).toBe(false);
    expect(result.errorCode).toBe('CONFIG_REQUIRED');
  });

  it('rejects configuration when scopes are missing or empty', () => {
    const missingScopesConfig: ExtensionConfig = {
      ...exampleConfig,
      oauth2: {
        clientId: '123456789.apps.googleusercontent.com',
        manifestPublicKey: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0',
        scopes: []
      }
    };
    const result = evaluateConfig(missingScopesConfig);
    expect(result.isConfigured).toBe(false);
    expect(result.errorCode).toBe('CONFIG_REQUIRED');
  });

  it('accepts valid complete identity capability metadata when configured', () => {
    const validConfig: ExtensionConfig = {
      ...exampleConfig,
      oauth2: {
        clientId: '123456789.apps.googleusercontent.com',
        manifestPublicKey: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0',
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
      }
    };
    const result = evaluateConfig(validConfig);
    expect(result.isConfigured).toBe(true);
    expect(result.clientId).toBe('123456789.apps.googleusercontent.com');
  });

  it('rejects malformed / null / non-object configs gracefully', () => {
    expect(evaluateConfig(null).isConfigured).toBe(false);
    expect(evaluateConfig(undefined).isConfigured).toBe(false);
    expect(evaluateConfig({} as ExtensionConfig).isConfigured).toBe(false);
  });
});
