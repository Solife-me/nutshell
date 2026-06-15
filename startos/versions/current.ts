import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

import { dependenciesForBackend } from '../dependencies'
import { storeJson } from '../fileModels/store.json'

export const current = VersionInfo.of({
  version: '0.20.0:7',
  releaseNotes: {
    en_US:
      'Add a StartOS maintenance action to inspect and repair stale pending swap locks after interrupted receive or swap operations.',
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
