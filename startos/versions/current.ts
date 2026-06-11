import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '0.20.0:0',
  releaseNotes: {
    en_US: 'Initial StartOS package for Nutshell.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
