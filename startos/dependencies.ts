import { sdk } from './sdk'
import { storeJson } from './fileModels/store.json'

export const setDependencies = sdk.setupDependencies(async ({ effects }) => {
  const backend = await storeJson
    .read((s) => s.lightningBackend)
    .const(effects)

  if (backend === 'lnd') {
    return {
      lnd: {
        kind: 'running',
        versionRange: '>=0.20.1-beta:2',
        healthChecks: ['lnd'],
      },
    }
  }

  if (backend === 'cln') {
    return {
      'c-lightning': {
        kind: 'running',
        versionRange: '>=25.12.1:8',
        healthChecks: ['lightningd'],
      },
    }
  }

  if (backend === 'lnbits') {
    return {
      lnbits: {
        kind: 'running',
        versionRange: '>=1.5.4:0',
        healthChecks: [],
      },
    }
  }

  if (backend === 'phoenixd') {
    return {
      phoenixd: {
        kind: 'running',
        versionRange: '>=0.8.0:0',
        healthChecks: [],
      },
    }
  }

  return {}
})
