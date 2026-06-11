import { i18n } from '../i18n'
import { storeJson } from '../fileModels/store.json'
import { sdk } from '../sdk'

const { InputSpec, Value } = sdk

const boolValues = {
  false: 'Disabled',
  true: 'Enabled',
} as const

type BoolValue = keyof typeof boolValues

const defaults = {
  mintBolt11DisableMelt: 'false' satisfies BoolValue,
  mintBolt11DisableMint: 'false' satisfies BoolValue,
  mintGlobalRateLimitPerMinute: '60',
  mintInfoDescription: 'StartOS-packaged Cashu mint',
  mintInfoName: 'Nutshell on StartOS',
  mintInputFeePpk: '100',
  mintRateLimit: 'false' satisfies BoolValue,
  mintTransactionRateLimitPerMinute: '20',
}

const asBool = (value: string | undefined): BoolValue =>
  value === 'true' ? 'true' : 'false'

const clean = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed || undefined
}

const cleanList = (value: string | null | undefined): string | undefined => {
  const values = clean(value)
    ?.split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)

  return values?.length ? values.join('\n') : undefined
}

const integer = (
  label: string,
  value: string | null | undefined,
  required = false,
): string | undefined => {
  const cleaned = clean(value)
  if (!cleaned) {
    if (required) throw new Error(`${label} is required`)
    return undefined
  }

  if (!/^\d+$/.test(cleaned)) {
    throw new Error(`${label} must be a whole number`)
  }

  return cleaned
}

const requiredText = (
  label: string,
  value: string | null | undefined,
): string => {
  const cleaned = clean(value)
  if (!cleaned) throw new Error(`${label} is required`)
  return cleaned
}

export const inputSpec = InputSpec.of({
  mintInfoName: Value.text({
    name: i18n('Mint Name'),
    description: i18n('Public name shown to wallets'),
    default: defaults.mintInfoName,
    required: true,
    masked: false,
  }),
  mintInfoDescription: Value.text({
    name: i18n('Short Description'),
    description: i18n('Brief public description shown to wallets'),
    default: defaults.mintInfoDescription,
    required: true,
    masked: false,
  }),
  mintUrl: Value.text({
    name: i18n('Public Mint URL'),
    description: i18n('Optional public URL wallets should use for this mint'),
    default: null,
    required: false,
    masked: false,
  }),
  mintInfoUrls: Value.text({
    name: i18n('Additional Public URLs'),
    description: i18n('Optional comma-separated or line-separated public URLs'),
    default: null,
    required: false,
    masked: false,
  }),
  mintInfoContactMethod: Value.text({
    name: i18n('Contact Method'),
    description: i18n('Optional contact type such as email, nostr, or twitter'),
    default: null,
    required: false,
    masked: false,
  }),
  mintInfoContactValue: Value.text({
    name: i18n('Contact Value'),
    description: i18n('Optional contact address or handle'),
    default: null,
    required: false,
    masked: false,
  }),
  mintInfoDescriptionLong: Value.text({
    name: i18n('Long Description'),
    description: i18n('Optional longer public description'),
    default: null,
    required: false,
    masked: false,
  }),
  mintInfoMotd: Value.text({
    name: i18n('Message of the Day'),
    description: i18n('Optional public message shown to wallets'),
    default: null,
    required: false,
    masked: false,
  }),
  mintInfoIconUrl: Value.text({
    name: i18n('Icon URL'),
    description: i18n('Optional public icon URL'),
    default: null,
    required: false,
    masked: false,
  }),
  mintInfoTosUrl: Value.text({
    name: i18n('Terms URL'),
    description: i18n('Optional terms of service URL'),
    default: null,
    required: false,
    masked: false,
  }),
  mintInputFeePpk: Value.text({
    name: i18n('Input Fee PPK'),
    description: i18n('Proof input fee in parts per thousand'),
    default: defaults.mintInputFeePpk,
    required: true,
    masked: false,
  }),
  mintBolt11DisableMint: Value.select({
    name: i18n('Disable Minting'),
    description: i18n('Turn off incoming Lightning deposits'),
    default: defaults.mintBolt11DisableMint,
    values: boolValues,
  }),
  mintBolt11DisableMelt: Value.select({
    name: i18n('Disable Melting'),
    description: i18n('Turn off outgoing Lightning withdrawals'),
    default: defaults.mintBolt11DisableMelt,
    values: boolValues,
  }),
  mintMaxMintBolt11Sat: Value.text({
    name: i18n('Maximum Deposit'),
    description: i18n('Optional per-deposit limit in sats; blank disables the limit'),
    default: null,
    required: false,
    masked: false,
  }),
  mintMaxMeltBolt11Sat: Value.text({
    name: i18n('Maximum Withdrawal'),
    description: i18n('Optional per-withdrawal limit in sats; blank disables the limit'),
    default: null,
    required: false,
    masked: false,
  }),
  mintMaxBalance: Value.text({
    name: i18n('Maximum Mint Balance'),
    description: i18n('Optional total issued balance limit in sats; blank disables the limit'),
    default: null,
    required: false,
    masked: false,
  }),
  mintRateLimit: Value.select({
    name: i18n('IP Rate Limiting'),
    description: i18n('Optional IP-based rate limiter'),
    default: defaults.mintRateLimit,
    values: boolValues,
  }),
  mintGlobalRateLimitPerMinute: Value.text({
    name: i18n('Global Requests Per Minute'),
    description: i18n('Used only when IP rate limiting is enabled'),
    default: defaults.mintGlobalRateLimitPerMinute,
    required: true,
    masked: false,
  }),
  mintTransactionRateLimitPerMinute: Value.text({
    name: i18n('Transaction Requests Per Minute'),
    description: i18n('Used only when IP rate limiting is enabled'),
    default: defaults.mintTransactionRateLimitPerMinute,
    required: true,
    masked: false,
  }),
})

export const configureMintSettings = sdk.Action.withInput(
  'configure-mint-settings',

  async () => ({
    name: i18n('Configure Mint Settings'),
    description: i18n('Edit public info, limits, and optional mint behavior'),
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  inputSpec,

  async ({ effects }) => {
    const store = await storeJson.read((s) => s).const(effects)
    return {
      mintBolt11DisableMelt: asBool(store?.mintBolt11DisableMelt),
      mintBolt11DisableMint: asBool(store?.mintBolt11DisableMint),
      mintGlobalRateLimitPerMinute:
        store?.mintGlobalRateLimitPerMinute ??
        defaults.mintGlobalRateLimitPerMinute,
      mintInfoContactMethod: store?.mintInfoContactMethod ?? null,
      mintInfoContactValue: store?.mintInfoContactValue ?? null,
      mintInfoDescription:
        store?.mintInfoDescription ?? defaults.mintInfoDescription,
      mintInfoDescriptionLong: store?.mintInfoDescriptionLong ?? null,
      mintInfoIconUrl: store?.mintInfoIconUrl ?? null,
      mintInfoMotd: store?.mintInfoMotd ?? null,
      mintInfoName: store?.mintInfoName ?? defaults.mintInfoName,
      mintInfoTosUrl: store?.mintInfoTosUrl ?? null,
      mintInfoUrls: store?.mintInfoUrls ?? null,
      mintInputFeePpk: store?.mintInputFeePpk ?? defaults.mintInputFeePpk,
      mintMaxBalance: store?.mintMaxBalance ?? null,
      mintMaxMeltBolt11Sat: store?.mintMaxMeltBolt11Sat ?? null,
      mintMaxMintBolt11Sat: store?.mintMaxMintBolt11Sat ?? null,
      mintRateLimit: asBool(store?.mintRateLimit),
      mintTransactionRateLimitPerMinute:
        store?.mintTransactionRateLimitPerMinute ??
        defaults.mintTransactionRateLimitPerMinute,
      mintUrl: store?.mintUrl ?? null,
    }
  },

  async ({ effects, input }) => {
    const contactMethod = clean(input.mintInfoContactMethod)
    const contactValue = clean(input.mintInfoContactValue)

    if ((contactMethod && !contactValue) || (!contactMethod && contactValue)) {
      throw new Error('Contact method and contact value must be set together')
    }

    await storeJson.merge(effects, {
      mintBolt11DisableMelt: input.mintBolt11DisableMelt,
      mintBolt11DisableMint: input.mintBolt11DisableMint,
      mintGlobalRateLimitPerMinute:
        integer(
          'Global requests per minute',
          input.mintGlobalRateLimitPerMinute,
          true,
        ) ?? defaults.mintGlobalRateLimitPerMinute,
      mintInfoContactMethod: contactMethod,
      mintInfoContactValue: contactValue,
      mintInfoDescription: requiredText(
        'Short description',
        input.mintInfoDescription,
      ),
      mintInfoDescriptionLong: clean(input.mintInfoDescriptionLong),
      mintInfoIconUrl: clean(input.mintInfoIconUrl),
      mintInfoMotd: clean(input.mintInfoMotd),
      mintInfoName: requiredText('Mint name', input.mintInfoName),
      mintInfoTosUrl: clean(input.mintInfoTosUrl),
      mintInfoUrls: cleanList(input.mintInfoUrls),
      mintInputFeePpk:
        integer('Input fee PPK', input.mintInputFeePpk, true) ??
        defaults.mintInputFeePpk,
      mintMaxBalance: integer('Maximum mint balance', input.mintMaxBalance),
      mintMaxMeltBolt11Sat: integer(
        'Maximum withdrawal',
        input.mintMaxMeltBolt11Sat,
      ),
      mintMaxMintBolt11Sat: integer(
        'Maximum deposit',
        input.mintMaxMintBolt11Sat,
      ),
      mintRateLimit: input.mintRateLimit,
      mintTransactionRateLimitPerMinute:
        integer(
          'Transaction requests per minute',
          input.mintTransactionRateLimitPerMinute,
          true,
        ) ?? defaults.mintTransactionRateLimitPerMinute,
      mintUrl: clean(input.mintUrl),
    })

    return {
      version: '1',
      title: i18n('Mint Settings Updated'),
      message: i18n('Nutshell will use the updated settings on next start'),
      result: null,
    }
  },
)
