export interface OAuth2Config {
  clientId: string | null;
  manifestPublicKey: string | null;
  scopes: string[];
}

export interface EndpointsConfig {
  sheetsApiBase: string;
  driveApiBase: string;
  userInfoEndpoint: string;
}

export interface OfflineBuildConfig {
  omitOAuthMetadataWhenUnconfigured: boolean;
  unconfiguredErrorCode: string;
}

export interface ExtensionConfig {
  $comment?: string;
  oauth2: OAuth2Config;
  endpoints: EndpointsConfig;
  offlineBuild: OfflineBuildConfig;
}
