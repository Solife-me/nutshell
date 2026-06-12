import { i18n } from '../i18n'
import { dependenciesForBackend } from '../dependencies'
import { storeJson } from '../fileModels/store.json'
import { sdk } from '../sdk'

const { InputSpec, Value } = sdk

export const backendValues = {
  fakewallet: 'FakeWallet',
  lnbits: 'LNbits on this StartOS server',
  lnd: 'LND on this StartOS server',
  phoenixd: 'phoenixd on this StartOS server',
  cln: 'Core Lightning on this StartOS server',
} as const

type Backend = keyof typeof backendValues

const normalizeBackend = (backend: string | undefined): Backend => {
  if (backend && backend in backendValues) return backend as Backend
  return 'lnd'
}

export const inputSpec = InputSpec.of({
  backend: Value.select({
    name: i18n('Lightning Backend'),
    description: i18n('Choose the same-server Lightning backend for Nutshell'),
    default: 'lnd',
    values: backendValues,
  }),
  lnbitsKey: Value.text({
    name: i18n('LNbits API Key'),
    description: i18n('Required only when LNbits is selected'),
    default: null,
    required: false,
    masked: true,
  }),
})

export const configureLightningBackend = sdk.Action.withInput(
  'configure-lightning-backend',

  async () => ({
    name: i18n('Configure Lightning Backend'),
    description: i18n('Select LNbits, LND, phoenixd, CLN, or FakeWallet'),
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  inputSpec,

  async ({ effects }) => {
    const store = await storeJson.read((s) => s).const(effects)
    return {
      backend: normalizeBackend(store?.lightningBackend),
      lnbitsKey: store?.lnbitsKey ?? null,
    }
  },

  async ({ effects, input }) => {
    if (input.backend === 'lnbits' && !input.lnbitsKey) {
      throw new Error('LNbits requires an API key')
    }

    await storeJson.merge(effects, {
      lightningBackend: input.backend,
      lnbitsKey: input.lnbitsKey || undefined,
    })

    await effects.setDependencies({
      dependencies: dependenciesForBackend(input.backend),
    })

    return {
      version: '1',
      title: i18n('Lightning Backend Updated'),
      message: i18n('Nutshell will use the selected backend on next start'),
      result: null,
    }
  },
)
