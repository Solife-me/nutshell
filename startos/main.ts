import { i18n } from './i18n'
import { storeJson } from './fileModels/store.json'
import { sdk } from './sdk'
import { apiPort, dataDir, packageId } from './utils'

const backendEnv = (
  backend: string | undefined,
  lnbitsKey: string | undefined,
) => {
  switch (backend) {
    case 'lnd':
      return {
        MINT_BACKEND_BOLT11_SAT: 'LndRestWallet',
        MINT_LND_REST_CERT: '/mnt/lnd/tls.cert',
        MINT_LND_REST_CERT_VERIFY: 'TRUE',
        MINT_LND_REST_ENDPOINT: 'https://lnd.startos:8080',
        MINT_LND_REST_MACAROON:
          '/mnt/lnd/data/chain/bitcoin/mainnet/admin.macaroon',
      }
    case 'cln':
      return {
        MINT_BACKEND_BOLT11_SAT: 'CLNRestWallet',
        MINT_CLNREST_CERT: '/mnt/cln/bitcoin/ca.pem',
        MINT_CLNREST_RUNE: '/mnt/cln/.commando-env',
        MINT_CLNREST_URL: 'https://c-lightning.startos:3010',
      }
    case 'lnbits':
      return {
        MINT_BACKEND_BOLT11_SAT: 'LNbitsWallet',
        MINT_LNBITS_ENDPOINT: 'http://lnbits.startos:5000',
        MINT_LNBITS_KEY: lnbitsKey ?? '',
      }
    case 'phoenixd':
      return {
        MINT_BACKEND_BOLT11_SAT: 'PhoenixdWallet',
        MINT_PHOENIXD_ENDPOINT: 'http://phoenixd.startos:9740',
        MINT_PHOENIXD_PASSWORD: '/mnt/phoenixd/phoenix.conf',
      }
    default:
      return {
        MINT_BACKEND_BOLT11_SAT: 'FakeWallet',
      }
  }
}

type MintSettingsStore = {
  mintBolt11DisableMelt?: string
  mintBolt11DisableMint?: string
  mintGlobalRateLimitPerMinute?: string
  mintInfoContactMethod?: string
  mintInfoContactValue?: string
  mintInfoDescription?: string
  mintInfoDescriptionLong?: string
  mintInfoIconUrl?: string
  mintInfoMotd?: string
  mintInfoName?: string
  mintInfoTosUrl?: string
  mintInfoUrls?: string
  mintInputFeePpk?: string
  mintMaxBalance?: string
  mintMaxMeltBolt11Sat?: string
  mintMaxMintBolt11Sat?: string
  mintRateLimit?: string
  mintTransactionRateLimitPerMinute?: string
  mintUrl?: string
}

const enabledEnv = (value: string | undefined): 'TRUE' | 'FALSE' =>
  value === 'true' ? 'TRUE' : 'FALSE'

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed || undefined
}

const addOptional = (
  env: Record<string, string>,
  key: string,
  value: string | undefined,
) => {
  const cleaned = clean(value)
  if (cleaned) env[key] = cleaned
}

const infoUrlsEnv = (value: string | undefined): string | undefined => {
  const urls = clean(value)
    ?.split(/[\n,]+/)
    .map((url) => url.trim())
    .filter(Boolean)

  return urls?.length ? JSON.stringify(urls) : undefined
}

const mintSettingsEnv = (store: MintSettingsStore): Record<string, string> => {
  const env: Record<string, string> = {
    MINT_BOLT11_DISABLE_MELT: enabledEnv(store.mintBolt11DisableMelt),
    MINT_BOLT11_DISABLE_MINT: enabledEnv(store.mintBolt11DisableMint),
    MINT_GLOBAL_RATE_LIMIT_PER_MINUTE:
      clean(store.mintGlobalRateLimitPerMinute) ?? '60',
    MINT_INFO_DESCRIPTION:
      clean(store.mintInfoDescription) ?? 'StartOS-packaged Cashu mint',
    MINT_INFO_NAME: clean(store.mintInfoName) ?? 'Nutshell on StartOS',
    MINT_INPUT_FEE_PPK: clean(store.mintInputFeePpk) ?? '100',
    MINT_RATE_LIMIT: enabledEnv(store.mintRateLimit),
    MINT_REDIS_CACHE_ENABLED: 'FALSE',
    MINT_REQUIRE_AUTH: 'FALSE',
    MINT_RPC_SERVER_ENABLE: 'FALSE',
    MINT_TRANSACTION_RATE_LIMIT_PER_MINUTE:
      clean(store.mintTransactionRateLimitPerMinute) ?? '20',
  }

  addOptional(env, 'MINT_INFO_DESCRIPTION_LONG', store.mintInfoDescriptionLong)
  addOptional(env, 'MINT_INFO_ICON_URL', store.mintInfoIconUrl)
  addOptional(env, 'MINT_INFO_MOTD', store.mintInfoMotd)
  addOptional(env, 'MINT_INFO_TOS_URL', store.mintInfoTosUrl)
  addOptional(env, 'MINT_MAX_BALANCE', store.mintMaxBalance)
  addOptional(env, 'MINT_MAX_MELT_BOLT11_SAT', store.mintMaxMeltBolt11Sat)
  addOptional(env, 'MINT_MAX_MINT_BOLT11_SAT', store.mintMaxMintBolt11Sat)
  addOptional(env, 'MINT_URL', store.mintUrl)

  const infoUrls = infoUrlsEnv(store.mintInfoUrls)
  if (infoUrls) env.MINT_INFO_URLS = infoUrls

  const contactMethod = clean(store.mintInfoContactMethod)
  const contactValue = clean(store.mintInfoContactValue)
  if (contactMethod && contactValue) {
    env.MINT_INFO_CONTACT = JSON.stringify([[contactMethod, contactValue]])
  }

  return env
}

export const main = sdk.setupMain(async ({ effects }) => {
  console.info(i18n('Starting Nutshell mint!'))

  const store = await storeJson.read((s) => s).const(effects)
  if (!store?.mintPrivateKey) {
    throw new Error('Nutshell has not been initialized with a mint private key')
  }

  const mintPrivateKey = store.mintPrivateKey

  if (store.lightningBackend === 'lnbits' && !store.lnbitsKey) {
    throw new Error('LNbits backend selected but no API key is configured')
  }

  let mounts = sdk.Mounts.of().mountVolume({
    volumeId: 'main',
    subpath: null,
    mountpoint: dataDir,
    readonly: false,
  })

  if (store.lightningBackend === 'lnd') {
    mounts = mounts.mountDependency({
      dependencyId: 'lnd',
      volumeId: 'main',
      subpath: null,
      mountpoint: '/mnt/lnd',
      readonly: true,
    })
  } else if (store.lightningBackend === 'cln') {
    mounts = mounts.mountDependency({
      dependencyId: 'c-lightning',
      volumeId: 'main',
      subpath: null,
      mountpoint: '/mnt/cln',
      readonly: true,
    })
  } else if (store.lightningBackend === 'phoenixd') {
    mounts = mounts.mountDependency({
      dependencyId: 'phoenixd',
      volumeId: 'main',
      subpath: null,
      mountpoint: '/mnt/phoenixd',
      readonly: true,
    })
  }

  const subcontainer = await sdk.SubContainer.of(
    effects,
    { imageId: packageId },
    mounts,
    'nutshell-sub',
  )

  return sdk.Daemons.of(effects).addDaemon('primary', {
    subcontainer,
    exec: {
      command: sdk.useEntrypoint(),
      env: {
        CASHU_DIR: dataDir,
        ...backendEnv(store.lightningBackend, store.lnbitsKey),
        ...mintSettingsEnv(store),
        MINT_AUTH_DATABASE: `${dataDir}/auth`,
        MINT_DATABASE: `${dataDir}/mint`,
        MINT_LISTEN_HOST: '0.0.0.0',
        MINT_LISTEN_PORT: apiPort.toString(),
        MINT_PRIVATE_KEY: mintPrivateKey,
        TOR: 'FALSE',
      },
    },
    ready: {
      display: i18n('Mint API'),
      fn: () =>
        sdk.healthCheck.checkPortListening(effects, apiPort, {
          successMessage: i18n('The mint API is ready'),
          errorMessage: i18n('The mint API is not ready'),
        }),
    },
    requires: [],
  })
})
