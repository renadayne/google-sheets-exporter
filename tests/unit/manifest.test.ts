import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Manifest V3 offline build requirements', () => {
  const publicManifestPath = resolve(process.cwd(), 'public/manifest.json');
  const manifestRaw = readFileSync(publicManifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw);

  it('declares Manifest V3 with module service worker', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toEqual({
      service_worker: 'service-worker.js',
      type: 'module'
    });
  });

  it('permits only reviewed Chrome permissions (identity, activeTab, downloads)', () => {
    const allowedPermissions = ['identity', 'activeTab', 'downloads'];
    expect(manifest.permissions).toEqual(allowedPermissions);

    // Verify forbidden broad permissions are absent
    const forbidden = ['tabs', 'cookies', 'scripting', 'webRequest', 'clipboardRead', 'unlimitedStorage'];
    for (const p of forbidden) {
      expect(manifest.permissions).not.toContain(p);
    }
  });

  it('permits only reviewed Google API host permissions', () => {
    const allowedHosts = [
      'https://sheets.googleapis.com/*',
      'https://www.googleapis.com/*'
    ];
    expect(manifest.host_permissions).toEqual(allowedHosts);
  });

  it('enforces strict CSP with no remote code or eval', () => {
    const csp = manifest.content_security_policy?.extension_pages;
    expect(csp).toBeDefined();
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'self'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).not.toContain('unsafe-eval');
    const directives = Object.fromEntries(csp.split(';').map((part: string) => part.trim().split(/\s+/)).filter((parts: string[]) => parts[0]).map(([name, ...values]: string[]) => [name, values]));
    expect(directives['script-src']).toEqual(["'self'"]);
    expect(directives['connect-src']).toEqual(["'self'", 'https://sheets.googleapis.com', 'https://www.googleapis.com']);
  });

  it('omits oauth2 and key metadata in unconfigured offline builds', () => {
    // Critical security invariant: never bundle bogus credentials or null placeholders into manifest
    expect(manifest.oauth2).toBeUndefined();
    expect(manifest.key).toBeUndefined();
  });

  it('matches dist manifest if build output exists', () => {
    const distManifestPath = resolve(process.cwd(), 'dist/manifest.json');
    if (existsSync(distManifestPath)) {
      const distManifest = JSON.parse(readFileSync(distManifestPath, 'utf8'));
      expect(distManifest.manifest_version).toBe(3);
      expect(distManifest.oauth2).toBeUndefined();
      expect(distManifest.key).toBeUndefined();
      expect(distManifest.permissions).toEqual(manifest.permissions);
    }
  });
});
