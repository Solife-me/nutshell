import type { T } from '@start9labs/start-sdk'

import { i18n } from '../i18n'
import { sdk } from '../sdk'
import { dataDir, packageId } from '../utils'

const { InputSpec, Value } = sdk

const modeValues = {
  inspect: 'Inspect only',
  fix: 'Reset the reported balance',
} as const

type ReconcileMode = keyof typeof modeValues

type KeysetRow = {
  counter: number
  drift: number
  expected_counter: number
  id: string
  issued: number
  outstanding: number
  pending: number
  redeemed: number
  unit: string
}

type QuoteRow = {
  amount: number
  proof_amount?: number
  quote: string
  state: string
}

type ReconcileResult = {
  anomalies: {
    pending_quotes_without_locked_proofs?: QuoteRow[]
    spent_proofs_on_unpaid_quotes?: QuoteRow[]
  }
  fixed: { from: number; id: string; to: number; unit: string }[]
  keysets: KeysetRow[]
  ledgerInconsistent: boolean
}

const formatInteger = (value: number): string => {
  const sign = value < 0 ? '-' : ''
  return `${sign}${Math.abs(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}

export const inputSpec = InputSpec.of({
  mode: Value.select({
    name: i18n('Mode'),
    description: i18n(
      'Inspect compares the reported balance against the signature ledger and changes nothing. Reset rewrites the reported balance to match the ledger; it never touches issued or spent ecash',
    ),
    default: 'inspect' as const,
    values: modeValues,
  }),
})

const runReconcile = async (
  effects: T.Effects,
  mode: ReconcileMode,
): Promise<ReconcileResult> => {
  const status = await sdk.getStatus(effects).once()
  if (status?.desired.main !== 'stopped') {
    throw new Error('Stop Nutshell before reconciling its balance')
  }

  const mounts = sdk.Mounts.of().mountVolume({
    volumeId: 'main',
    subpath: null,
    mountpoint: dataDir,
    readonly: false,
  })

  return await sdk.SubContainer.withTemp(
    effects,
    { imageId: packageId },
    mounts,
    'nutshell-reconcile-balance-action',
    async (subcontainer) => {
      const args = [
        'python3',
        '/app/scripts/reconcile_mint_balance.py',
        '--db',
        `${dataDir}/mint/mint.sqlite3`,
        '--json',
      ]
      if (mode === 'fix') args.push('--fix-counter')

      const output = await subcontainer.exec(args, {}, 120_000)

      if (output.exitCode !== 0) {
        const stderr = output.stderr.toString().trim()
        const stdout = output.stdout.toString().trim()
        throw new Error(stderr || stdout || 'Unable to reconcile mint balance')
      }

      return JSON.parse(output.stdout.toString()) as ReconcileResult
    },
  )
}

const summarize = (result: ReconcileResult) => {
  const byUnit = new Map<
    string,
    { counter: number; drift: number; outstanding: number; pending: number }
  >()
  for (const ks of result.keysets) {
    const u = byUnit.get(ks.unit) ?? {
      counter: 0,
      drift: 0,
      outstanding: 0,
      pending: 0,
    }
    u.counter += ks.counter
    u.drift += ks.drift
    u.outstanding += ks.outstanding
    u.pending += ks.pending
    byUnit.set(ks.unit, u)
  }

  return [...byUnit.entries()].map(([unit, u]) => ({
    name: unit,
    description: [
      `reported ${formatInteger(u.counter)}`,
      `outstanding ecash ${formatInteger(u.outstanding)}`,
      `locked ${formatInteger(u.pending)}`,
      `drift ${formatInteger(u.drift)}`,
    ].join(' · '),
    type: 'single' as const,
    value: `${formatInteger(u.outstanding)} ${unit}`,
    copyable: true,
    qr: false,
    masked: false,
  }))
}

export const reconcileBalance = sdk.Action.withInput(
  'reconcile-balance',

  async () => ({
    name: i18n('Reconcile Mint Balance'),
    description: i18n(
      'Compare the reported mint balance against the ledger of what was signed and spent',
    ),
    warning: i18n(
      'Stop Nutshell and back up its data first. Reset only rewrites the reported balance counter; it never touches issued or spent ecash, and it refuses to run if the ledger itself is inconsistent.',
    ),
    allowedStatuses: 'only-stopped',
    group: i18n('Maintenance'),
    visibility: 'enabled',
  }),

  inputSpec,

  async () => ({ mode: 'inspect' as const }),

  async ({ effects, input }) => {
    const result = await runReconcile(effects, input.mode)

    if (result.ledgerInconsistent) {
      return {
        version: '1',
        title: i18n('Ledger Inconsistent'),
        message: i18n(
          'More ecash was redeemed than was ever signed. That is not counter drift and the balance was NOT reset. Investigate before running this again.',
        ),
        result: { type: 'group', value: summarize(result) },
      }
    }

    const drifted = result.keysets.some((k) => k.drift !== 0)
    const unpaidQuotes =
      result.anomalies.spent_proofs_on_unpaid_quotes?.length ?? 0

    if (input.mode === 'fix') {
      return {
        version: '1',
        title: i18n('Balance Reset'),
        message: i18n(
          'The reported balance now matches the ledger. No ecash was modified.',
        ),
        result: { type: 'group', value: summarize(result) },
      }
    }

    return {
      version: '1',
      title: i18n('Mint Balance Reconciliation'),
      message: drifted
        ? i18n(
            'The reported balance does not match the ledger. Outstanding ecash is your real liability; compare it against your Lightning balance, then re-run with Reset.',
          )
        : unpaidQuotes > 0
          ? i18n(
              'The reported balance matches the ledger, but some melt quotes hold spent proofs without being marked paid. Check those invoices against your Lightning node.',
            )
          : i18n('The reported balance matches the ledger.'),
      result: { type: 'group', value: summarize(result) },
    }
  },
)
