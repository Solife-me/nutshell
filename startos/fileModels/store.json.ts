import { FileHelper, z } from '@start9labs/start-sdk'

import { sdk } from '../sdk'

const optionalString = z.string().optional().catch(undefined)

const shape = z.object({
  lightningBackend: z.string().catch('fakewallet'),
  lnbitsKey: optionalString,
  mintBolt11DisableMelt: z.string().catch('false'),
  mintBolt11DisableMint: z.string().catch('false'),
  mintGlobalRateLimitPerMinute: z.string().catch('60'),
  mintInfoContactMethod: optionalString,
  mintInfoContactValue: optionalString,
  mintInfoDescription: z.string().catch('StartOS-packaged Cashu mint'),
  mintInfoDescriptionLong: optionalString,
  mintInfoIconUrl: optionalString,
  mintInfoMotd: optionalString,
  mintInfoName: z.string().catch('Nutshell on StartOS'),
  mintInfoTosUrl: optionalString,
  mintInfoUrls: optionalString,
  mintInputFeePpk: z.string().catch('100'),
  mintMaxBalance: optionalString,
  mintMaxMeltBolt11Sat: optionalString,
  mintMaxMintBolt11Sat: optionalString,
  mintPrivateKey: z.string(),
  mintRateLimit: z.string().catch('false'),
  mintTransactionRateLimitPerMinute: z.string().catch('20'),
  mintUrl: optionalString,
})

export const storeJson = FileHelper.json(
  { base: sdk.volumes.main, subpath: 'store.json' },
  shape,
)
