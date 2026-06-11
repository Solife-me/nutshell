import { FileHelper, matches } from '@start9labs/start-sdk'

import { sdk } from '../sdk'

const { object, string } = matches

const shape = object({
  lightningBackend: string.onMismatch('fakewallet'),
  lnbitsKey: string.optional().onMismatch(undefined),
  mintBolt11DisableMelt: string.onMismatch('false'),
  mintBolt11DisableMint: string.onMismatch('false'),
  mintGlobalRateLimitPerMinute: string.onMismatch('60'),
  mintInfoContactMethod: string.optional().onMismatch(undefined),
  mintInfoContactValue: string.optional().onMismatch(undefined),
  mintInfoDescription: string.onMismatch('StartOS-packaged Cashu mint'),
  mintInfoDescriptionLong: string.optional().onMismatch(undefined),
  mintInfoIconUrl: string.optional().onMismatch(undefined),
  mintInfoMotd: string.optional().onMismatch(undefined),
  mintInfoName: string.onMismatch('Nutshell on StartOS'),
  mintInfoTosUrl: string.optional().onMismatch(undefined),
  mintInfoUrls: string.optional().onMismatch(undefined),
  mintInputFeePpk: string.onMismatch('100'),
  mintMaxBalance: string.optional().onMismatch(undefined),
  mintMaxMeltBolt11Sat: string.optional().onMismatch(undefined),
  mintMaxMintBolt11Sat: string.optional().onMismatch(undefined),
  mintPrivateKey: string,
  mintRateLimit: string.onMismatch('false'),
  mintTransactionRateLimitPerMinute: string.onMismatch('20'),
  mintUrl: string.optional().onMismatch(undefined),
})

export const storeJson = FileHelper.json(
  { base: sdk.volumes.main, subpath: 'store.json' },
  shape,
)
