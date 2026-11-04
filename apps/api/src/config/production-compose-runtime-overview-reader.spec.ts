import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';

describe.each(['docker-compose.yml', 'docker-compose.scale.yml'])(
  '%s machine overview credential scope',
  (file) => {
    const compose = readFileSync(resolve(__dirname, '../../../../infra', file), 'utf8');
    it('overrides inherited digest for every API role and enables it only on admin', () => {
      const anchor = compose.slice(0, compose.indexOf('\nservices:'));
      expect(anchor).toMatch(/^ {2}RUNTIME_OVERVIEW_READER_TOKEN_SHA256: ''$/mu);
      for (const service of RUNTIME_SERVICE_NAMES.filter((name) => name !== 'api-all')) {
        const block = compose.match(
          new RegExp(`\\n  ${service}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9_-]+:|\\nvolumes:|$)`, 'u'),
        )?.[1];
        expect(block).toBeDefined();
        expect(block).toContain('<<: *spammer-read-model-shadow-env');
        if (service === 'api-admin')
          expect(block).toContain(
            'RUNTIME_OVERVIEW_READER_TOKEN_SHA256: ${RUNTIME_OVERVIEW_READER_TOKEN_SHA256:-}',
          );
        else expect(block).not.toContain('RUNTIME_OVERVIEW_READER_TOKEN_SHA256:');
      }
      expect(compose).not.toContain('RUNTIME_OVERVIEW_READER_TOKEN:');
    });
  },
);
