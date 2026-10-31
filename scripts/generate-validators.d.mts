export interface GenerateValidatorsOptions {
  projectRoot?: string;
  outDir?: string;
  scratchDir?: string;
  check?: boolean;
}

export interface GenerateResult {
  written?: boolean;
  upToDate?: boolean;
  hash: string;
  files?: string[];
}

export function generateValidators(options?: GenerateValidatorsOptions): Promise<GenerateResult>;
export function computeSchemaHash(reportSchema: unknown, exportSchema: unknown, settings?: unknown): string;
export function canonicalJson(value: unknown): string;
export const PINNED_SETTINGS: Record<string, unknown>;
