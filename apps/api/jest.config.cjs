/** @type {import('jest').Config} */
module.exports = {
  testRegex: '.*\\.(spec|test)\\.ts$',
  moduleNameMapper: {
    '^@maxim/contracts/broadcast-buttons$':
      '<rootDir>/../../packages/contracts/src/broadcast-buttons.ts',
    '^@maxim/contracts/channel-settings$':
      '<rootDir>/../../packages/contracts/src/channel-settings.ts',
    '^@maxim/contracts/settings-field-schemas$':
      '<rootDir>/../../packages/contracts/src/settings-field-schemas.ts',
    '^@maxim/contracts/network-settings$':
      '<rootDir>/../../packages/contracts/src/network-settings.ts',
    '^@maxim/contracts/network-settings-read$':
      '<rootDir>/../../packages/contracts/src/network-settings-read.ts',
    '^@maxim/contracts/network-settings-actions$':
      '<rootDir>/../../packages/contracts/src/network-settings-actions.ts',
    '^@maxim/contracts/network-settings-metadata$':
      '<rootDir>/../../packages/contracts/src/network-settings-metadata.ts',
    '^@maxim/contracts/networks-stats$': '<rootDir>/../../packages/contracts/src/networks-stats.ts',
    '^@maxim/contracts/statistics-analytics$':
      '<rootDir>/../../packages/contracts/src/statistics-analytics.ts',
    '^@maxim/contracts/statistics-analytics-validation$':
      '<rootDir>/../../packages/contracts/src/statistics-analytics-validation.ts',
    '^@maxim/contracts/statistics-central$':
      '<rootDir>/../../packages/contracts/src/statistics-central.ts',
    '^@maxim/contracts/statistics-central-validation$':
      '<rootDir>/../../packages/contracts/src/statistics-central-validation.ts',
    '^@maxim/contracts/statistics-exchange-v3$':
      '<rootDir>/../../packages/contracts/src/statistics-exchange-v3.ts',
    '^@maxim/contracts/marketplace-integration$':
      '<rootDir>/../../packages/contracts/src/marketplace-integration.ts',
    '^@maxim/contracts/advertising-placement$':
      '<rootDir>/../../packages/contracts/src/advertising-placement.ts',
    '^@maxim/contracts$': '<rootDir>/../../packages/contracts/src/index.ts',
    '^@maxim/contracts/bot-speech-fields$':
      '<rootDir>/../../packages/contracts/src/bot-speech-fields.ts',
    '^@maxim/contracts/bot-speech$': '<rootDir>/../../packages/contracts/src/bot-speech.ts',
    '^@maxim/contracts/broadcast$': '<rootDir>/../../packages/contracts/src/broadcast.ts',
    '^@maxim/contracts/channel-dialog$': '<rootDir>/../../packages/contracts/src/channel-dialog.ts',
    '^@maxim/contracts/channel-post-signature$':
      '<rootDir>/../../packages/contracts/src/channel-post-signature.ts',
    '^@maxim/contracts/channel-stats$': '<rootDir>/../../packages/contracts/src/channel-stats.ts',
    '^@maxim/contracts/chat-participants$':
      '<rootDir>/../../packages/contracts/src/chat-participants.ts',
    '^@maxim/contracts/chat-sanctions$': '<rootDir>/../../packages/contracts/src/chat-sanctions.ts',
    '^@maxim/contracts/participant-details$':
      '<rootDir>/../../packages/contracts/src/participant-details.ts',
    '^@maxim/contracts/giveaway$': '<rootDir>/../../packages/contracts/src/giveaway.ts',
    '^@maxim/contracts/karavan-marketplace$':
      '<rootDir>/../../packages/contracts/src/karavan-marketplace.ts',
    '^@maxim/contracts/karavan-marketplace-management$':
      '<rootDir>/../../packages/contracts/src/karavan-marketplace-management.ts',
    '^@maxim/contracts/karavan-storefront$':
      '<rootDir>/../../packages/contracts/src/karavan-storefront.ts',
    '^@maxim/contracts/managed-entities$':
      '<rootDir>/../../packages/contracts/src/managed-entities.ts',
    '^@maxim/contracts/manual-moderation$':
      '<rootDir>/../../packages/contracts/src/manual-moderation.ts',
    '^@maxim/contracts/max-capabilities$':
      '<rootDir>/../../packages/contracts/src/max-capabilities.ts',
    '^@maxim/contracts/poll$': '<rootDir>/../../packages/contracts/src/poll.ts',
    '^@maxim/contracts/publication$': '<rootDir>/../../packages/contracts/src/publication.ts',
    '^@maxim/contracts/publication-draft$':
      '<rootDir>/../../packages/contracts/src/publication-draft.ts',
    '^@maxim/contracts/publication-post-action-request$':
      '<rootDir>/../../packages/contracts/src/publication-post-action-request.ts',
    '^@maxim/contracts/publisher$': '<rootDir>/../../packages/contracts/src/publisher.ts',
    '^@maxim/contracts/publisher-auto-replies$':
      '<rootDir>/../../packages/contracts/src/publisher-auto-replies.ts',
    '^@maxim/contracts/safety-desk$': '<rootDir>/../../packages/contracts/src/safety-desk.ts',
    '^@maxim/contracts/commercial-ai-quality$':
      '<rootDir>/../../packages/contracts/src/commercial-ai-quality.ts',
    '^@maxim/contracts/reports$': '<rootDir>/../../packages/contracts/src/reports.ts',
    '^@maxim/contracts/settings-apply-error$':
      '<rootDir>/../../packages/contracts/src/settings-apply-error.ts',
    '^@maxim/contracts/settings$': '<rootDir>/../../packages/contracts/src/settings.ts',
    '^@maxim/contracts/support-requests$':
      '<rootDir>/../../packages/contracts/src/support-requests.ts',
    '^@maxim/contracts/system$': '<rootDir>/../../packages/contracts/src/system.ts',
    '^@maxim/contracts/vk-parsing$': '<rootDir>/../../packages/contracts/src/vk-parsing.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
    'node_modules/(?:file-type|strtok3|token-types|uint8array-extras|@tokenizer/inflate|@borewit/text-codec)/.+\\.js$':
      '<rootDir>/test/jest-esm-to-cjs-transformer.cjs',
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(?:file-type|strtok3|token-types|uint8array-extras|@tokenizer/inflate|@borewit/text-codec)/)',
  ],
  setupFilesAfterEnv: ['<rootDir>/test/setup-silent-logs.ts'],
  collectCoverageFrom: ['src/**/*.ts'],
  coverageDirectory: '<rootDir>/coverage',
  testEnvironment: 'node',
};
