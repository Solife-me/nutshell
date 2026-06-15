import { sdk } from './sdk'
import { storeJson } from './fileModels/store.json'

export const dependenciesForBackend = (backend: string | null | undefined) => {
  if (backend === 'lnd') {
    return [
      {
        id: 'lnd',
        kind: 'running' as const,
        versionRange: '>=0.20.1-beta:2',
        healthChecks: ['lnd'],
      },
    ]
  }

  if (backend === 'cln') {
    return [
      {
        id: 'c-lightning',
        kind: 'running' as const,
        versionRange: '*',
        healthChecks: [],
      },
    ]
  }

  if (backend === 'lnbits') {
    return [
      {
        id: 'lnbits',
        kind: 'running' as const,
        versionRange: '>=1.5.4:0',
        healthChecks: [],
      },
    ]
  }

  if (backend === 'phoenixd') {
    return [
      {
        id: 'phoenixd',
        kind: 'running' as const,
        versionRange: '>=0.8.0:0',
        healthChecks: [],
      },
    ]
  }

  return []
}

export const setDependencies = sdk.setupDependencies(async ({ effects }) => {
  const backend = await storeJson
    .read((s) => s.lightningBackend)
    .const(effects)

  return Object.fromEntries(
    dependenciesForBackend(backend).map(({ id, ...dependency }) => [
      id,
      dependency,
    ]),
  )
})
