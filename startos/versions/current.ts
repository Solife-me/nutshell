import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

import { dependenciesForBackend } from '../dependencies'
import { storeJson } from '../fileModels/store.json'

export const current = VersionInfo.of({
  version: '0.20.1:0',
  releaseNotes: {
    en_US:
      'Update Nutshell to 0.20.1 and rebuild the package with StartOS SDK 2.0.9.',
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
