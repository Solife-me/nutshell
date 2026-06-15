import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

import { dependenciesForBackend } from '../dependencies'
import { storeJson } from '../fileModels/store.json'

export const current = VersionInfo.of({
  version: '0.20.0:6',
  releaseNotes: {
    en_US:
      'Allow any installed Core Lightning package version and use the internal CLN REST HTTP endpoint.',
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
