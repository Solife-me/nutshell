import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

import { dependenciesForBackend } from '../dependencies'
import { storeJson } from '../fileModels/store.json'

export const current = VersionInfo.of({
  version: '0.20.0:8',
  releaseNotes: {
    en_US:
      'Expand the StartOS pending proof repair action to inspect melt locks, clear recoverable locks, and optionally force rollback failed pending Lightning melts.',
  },
  migrations: {
    up: async ({ effects }) => {
      const backend = await storeJson
        .read((s) => s.lightningBackend)
        .const(effects)

      await effects.setDependencies({
        dependencies: dependenciesForBackend(backend),
      })
    },
    down: IMPOSSIBLE,
  },
})
