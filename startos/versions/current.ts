import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

import { dependenciesForBackend } from '../dependencies'
import { storeJson } from '../fileModels/store.json'

export const current = VersionInfo.of({
  version: '0.20.3:1',
  releaseNotes: {
    en_US: `Updated to upstream Nutshell main at dbb4f96e (2026-09-15), based on 0.20.3.

- Includes upstream payment, validation, error-code, and dependency updates
- Uses upstream BOLT11 protocol behavior; removes the custom BOLT12 implementation
- Removes LNbits support to follow upstream; previously configured LNbits services must select a supported backend before starting
- Retains StartOS integration for LND, Core Lightning, phoenixd, and FakeWallet
- Core Lightning now uses the upstream xpay RPC
- Fixes the auth promises database schema to align with the mint CRUD layer

Complete outstanding BOLT12 mint and melt operations before upgrading. This release cannot service earlier BOLT12 offers or quotes.

[Full upstream changes](https://github.com/cashubtc/nutshell/compare/0.20.3...dbb4f96e)`,
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
