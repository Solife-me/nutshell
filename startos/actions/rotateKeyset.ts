import type { T } from '@start9labs/start-sdk'

import { i18n } from '../i18n'
import { storeJson } from '../fileModels/store.json'
import { sdk } from '../sdk'
import { dataDir, packageId } from '../utils'

const { InputSpec, Value } = sdk

const modeValues = {
  inspect: 'Inspect only',
  rotate: 'Rotate to a new keyset',
} as const

type RotateMode = keyof typeof modeValues

const unitValues = {
  sat: 'sat',
  usd: 'usd',
  eur: 'eur',
} as const

type KeysetRow = {
  active: boolean
  balance: string
  derivationPath: string
  finalExpiry: number | null
  id: string
  inputFeePpk: number
  unit: string
}

type RotateResult = {
  keysets: KeysetRow[]
  mode: RotateMode
  newKeysetId: string | null
  retiredKeysetIds: string[]
  unit: string
}

// Runs inside the Nutshell image, so it drives the mint's own keyset code
// rather than reimplementing key derivation against raw SQL. Getting the
// derivation or the keyset id wrong would mint ecash nobody can redeem.
const rotateScript = String.raw`
import asyncio
import json
import os
import sys


async def main():
    from cashu.core.base import Unit
    from cashu.core.db import Database
    from cashu.core.settings import settings
    from cashu.mint.crud import LedgerCrudSqlite
    from cashu.mint.ledger import Ledger

    mode = os.environ.get("ROTATE_MODE", "inspect")
    if mode not in ("inspect", "rotate"):
        raise ValueError("Invalid rotate mode")

    unit_name = os.environ.get("ROTATE_UNIT", "sat")
    fee_raw = os.environ.get("ROTATE_INPUT_FEE_PPK", "").strip()

    if not settings.mint_private_key:
        raise ValueError("MINT_PRIVATE_KEY is not set")

    ledger = Ledger(
        db=Database("mint", settings.mint_database),
        seed=settings.mint_private_key,
        seed_decryption_key=settings.mint_seed_decryption_key,
        derivation_path=settings.mint_derivation_path,
        crud=LedgerCrudSqlite(),
    )
    # autosave=False: inspecting must not create a keyset as a side effect
    await ledger.init_keysets(autosave=False)

    def snapshot():
        rows = []
        for keyset in ledger.keysets.values():
            rows.append(
                {
                    "active": bool(keyset.active),
                    "balance": str(int(keyset.balance or 0)),
                    "derivationPath": keyset.derivation_path,
                    "finalExpiry": keyset.final_expiry,
                    "id": keyset.id,
                    "inputFeePpk": int(keyset.input_fee_ppk or 0),
                    "unit": keyset.unit.name,
                }
            )
        rows.sort(key=lambda r: (r["unit"], r["derivationPath"]))
        return rows

    result = {
        "keysets": snapshot(),
        "mode": mode,
        "newKeysetId": None,
        "retiredKeysetIds": [],
        "unit": unit_name,
    }

    if mode == "inspect":
        print(json.dumps(result))
        return

    unit = Unit[unit_name]
    retiring = [
        keyset.id
        for keyset in ledger.keysets.values()
        if keyset.active and keyset.unit == unit
    ]
    if not retiring:
        raise ValueError(f"No active keyset for unit '{unit_name}' to rotate")

    input_fee_ppk = int(fee_raw) if fee_raw else None

    # NOTE: no final_expiry is set here. For v2 keysets the expiry is part of
    # the keyset id derivation, so it cannot be applied to an already-issued
    # keyset: the stored id would stop matching what a wallet derives from the
    # advertised fields, and wallets that verify ids would reject the keyset.
    new_keyset = await ledger.rotate_next_keyset(
        unit=unit,
        input_fee_ppk=input_fee_ppk,
        final_expiry=None,
    )

    result["keysets"] = snapshot()
    result["newKeysetId"] = new_keyset.id
    result["retiredKeysetIds"] = retiring
    print(json.dumps(result))


try:
    asyncio.run(main())
except Exception as exc:
    print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
    sys.exit(1)
`

export const inputSpec = InputSpec.of({
  mode: Value.select({
    name: i18n('Mode'),
    description: i18n(
      'Inspect lists your keysets without changing anything. Rotate retires the active keyset for the chosen unit and starts issuing on a new one',
    ),
    default: 'inspect' satisfies RotateMode,
    values: modeValues,
  }),
  unit: Value.select({
    name: i18n('Unit'),
    description: i18n('Which unit to rotate'),
    default: 'sat',
    values: unitValues,
  }),
  inputFeePpk: Value.text({
    name: i18n('Input Fee PPK'),
    description: i18n(
      'Fee for the new keyset in parts per thousand. Blank keeps the retiring keyset fee',
    ),
    default: null,
    required: false,
    masked: false,
  }),
})

const integer = (label: string, value: string | null | undefined): string => {
  const trimmed = value?.trim()
  if (!trimmed) return ''
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${label} must be a whole number`)
  }
  return trimmed
}

const runRotate = async (
  effects: T.Effects,
  input: {
    inputFeePpk: string
    mode: RotateMode
    unit: string
  },
): Promise<RotateResult> => {
  const status = await sdk.getStatus(effects).once()
  if (status?.desired.main !== 'stopped') {
    throw new Error('Stop Nutshell before rotating keysets')
  }

  const store = await storeJson.read((s) => s).const(effects)
  if (!store?.mintPrivateKey) {
    throw new Error('Nutshell has not been initialized with a mint private key')
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
    'nutshell-rotate-keyset-action',
    async (subcontainer) => {
      const output = await subcontainer.exec(
        ['python3', '-c', rotateScript],
        {
          env: {
            CASHU_DIR: dataDir,
            MINT_DATABASE: `${dataDir}/mint`,
            MINT_PRIVATE_KEY: store.mintPrivateKey,
            ROTATE_INPUT_FEE_PPK: input.inputFeePpk,
            ROTATE_MODE: input.mode,
            ROTATE_UNIT: input.unit,
          },
        },
        120_000,
      )

      if (output.exitCode !== 0) {
        const stderr = output.stderr.toString().trim()
        const stdout = output.stdout.toString().trim()
        throw new Error(stderr || stdout || 'Unable to rotate keyset')
      }

      return JSON.parse(output.stdout.toString()) as RotateResult
    },
  )
}

const describeKeyset = (keyset: KeysetRow) => ({
  name: `${keyset.id.slice(0, 16)} (${keyset.unit})`,
  description: [
    keyset.active ? 'active' : 'retired',
    `${keyset.balance} outstanding`,
    `${keyset.inputFeePpk} ppk`,
    keyset.derivationPath,
  ].join(' · '),
  type: 'single' as const,
  value: keyset.id,
  copyable: true,
  qr: false,
  masked: false,
})

export const rotateKeyset = sdk.Action.withInput(
  'rotate-keyset',

  async () => ({
    name: i18n('Rotate Keyset'),
    description: i18n(
      'Retire the active keyset for a unit and start issuing on a new one',
    ),
    warning: i18n(
      'Stop Nutshell and back up its data first. Rotating does NOT invalidate ecash already issued on the old keyset: the mint keeps accepting those proofs, it only stops creating new ones. Ecash cannot be revoked selectively.',
    ),
    allowedStatuses: 'only-stopped',
    group: i18n('Maintenance'),
    visibility: 'enabled',
  }),

  inputSpec,

  async () => ({
    inputFeePpk: null,
    mode: 'inspect' as const,
    unit: 'sat' as const,
  }),

  async ({ effects, input }) => {
    const result = await runRotate(effects, {
      inputFeePpk: integer('Input fee PPK', input.inputFeePpk),
      mode: input.mode,
      unit: input.unit,
    })

    if (result.mode === 'inspect') {
      return {
        version: '1',
        title: i18n('Keysets'),
        message: i18n(
          'These are the current keysets. Re-run with Rotate to retire the active one for the selected unit.',
        ),
        result: {
          type: 'group',
          value: result.keysets.map(describeKeyset),
        },
      }
    }

    return {
      version: '1',
      title: i18n('Keyset Rotated'),
      message: i18n(
        'Issuing now happens on the new keyset. Start Nutshell to pick it up. Ecash on the retired keyset stays redeemable.',
      ),
      result: {
        type: 'group',
        value: result.keysets.map(describeKeyset),
      },
    }
  },
)
