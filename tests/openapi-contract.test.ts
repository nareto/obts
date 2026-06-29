import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { API_VERSION } from '../src/shared/types.js';

describe('OpenAPI Phase 1 contract', () => {
  it('commits the endpoints and version used by the server and plugin', async () => {
    const contract = await readFile(join(process.cwd(), 'openapi', 'openapi.yaml'), 'utf8');
    for (const path of [
      '/setup',
      '/auth/login',
      '/vaults',
      '/vaults/{vault_id}/main',
      '/vaults/{vault_id}/pairing-tokens',
      '/pair/consume',
      '/vaults/{vault_id}/sync/push',
      '/vaults/{vault_id}/sync/pull',
      '/vaults/{vault_id}/conflicts',
      '/vaults/{vault_id}/events'
    ]) {
      expect(contract).toContain(path);
    }
    expect(contract).toContain(API_VERSION);
    expect(contract).toContain('ErrorEnvelope');
    expect(contract).toContain('__Host-obts_session');
    expect(contract).toContain('X-OBTS-CSRF');

    const pullSection = contract.slice(
      contract.indexOf('/vaults/{vault_id}/sync/pull'),
      contract.indexOf('/vaults/{vault_id}/conflicts')
    );
    expect(pullSection).toContain('multipart/form-data');
    expect(pullSection).toContain('DevicePullRequest');
    expect(pullSection).toContain('packfile');
    expect(pullSection).not.toContain('application/json:');
  });
});
