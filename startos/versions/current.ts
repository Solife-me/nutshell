import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

import { dependenciesForBackend } from '../dependencies'
import { storeJson } from '../fileModels/store.json'

export const current = VersionInfo.of({
  version: '0.20.3:0',
  releaseNotes: {
    en_US: `Updated Nutshell to 0.20.3 and rebuilt the package with StartOS SDK 2.0.9.

- Adds mint quote accounting and batch mint support
- Adds LND 0.21 compatibility
- Retains the StartOS package's Phoenixd and BOLT12 support

[Full upstream changes](https://github.com/cashubtc/nutshell/compare/0.20.1...0.20.3)`,
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
