import { randomBytes } from 'node:crypto'

import { configureLightningBackend } from '../actions/configureLightningBackend'
import { configureMintSettings } from '../actions/configureMintSettings'
import { i18n } from '../i18n'
import { storeJson } from '../fileModels/store.json'
import { sdk } from '../sdk'

export const initializeService = sdk.setupOnInit(async (effects, kind) => {
  if (kind !== 'install') return

  await storeJson.write(effects, {
    lightningBackend: 'fakewallet',
    lnbitsKey: undefined,
    mintBolt11DisableMelt: 'false',
    mintBolt11DisableMint: 'false',
    mintGlobalRateLimitPerMinute: '60',
    mintInfoContactMethod: undefined,
    mintInfoContactValue: undefined,
    mintInfoDescription: 'StartOS-packaged Cashu mint',
    mintInfoDescriptionLong: undefined,
    mintInfoIconUrl: undefined,
    mintInfoMotd: undefined,
    mintInfoName: 'Nutshell on StartOS',
    mintInfoTosUrl: undefined,
    mintInfoUrls: undefined,
    mintInputFeePpk: '100',
    mintMaxBalance: undefined,
    mintMaxMeltBolt11Sat: undefined,
    mintMaxMintBolt11Sat: undefined,
    mintPrivateKey: randomBytes(32).toString('hex'),
    mintRateLimit: 'false',
    mintTransactionRateLimitPerMinute: '20',
    mintUrl: undefined,
  })

  await sdk.action.createOwnTask(
    effects,
    configureMintSettings,
    'important',
    {
      reason: i18n('Review mint settings'),
    },
  )

  await sdk.action.createOwnTask(
    effects,
    configureLightningBackend,
    'important',
    {
      reason: i18n('Configure a Lightning backend'),
    },
  )
})
