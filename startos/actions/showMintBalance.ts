import type { T } from '@start9labs/start-sdk'

import { i18n } from '../i18n'
import { sdk } from '../sdk'
import { dataDir, packageId } from '../utils'

type BalanceRow = {
  balance: string
  unit: string
}

type BalanceQueryResult = {
  balances: BalanceRow[]
  initialized: boolean
}

const balanceScript = String.raw`
import json
import os
import sqlite3
import sys

db_path = os.environ.get("MINT_DB_PATH", "/data/mint/mint.sqlite3")

if not os.path.exists(db_path):
    print(json.dumps({"balances": [], "initialized": False}))
    sys.exit(0)

conn = None
try:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

    objects = {
        row["name"]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')"
        )
    }
    if "keysets" not in objects:
        print(json.dumps({"balances": [], "initialized": False}))
        sys.exit(0)

    keyset_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(keysets)")
    }

    if {"balance", "unit"}.issubset(keyset_columns):
        rows = conn.execute(
            """
            SELECT
                COALESCE(NULLIF(unit, ''), 'unknown') AS unit,
                COALESCE(SUM(balance), 0) AS balance
            FROM keysets
            GROUP BY COALESCE(NULLIF(unit, ''), 'unknown')
            ORDER BY unit
            """
        ).fetchall()
    elif "balance" in objects and "unit" in keyset_columns:
        rows = conn.execute(
            """
            SELECT
                COALESCE(NULLIF(k.unit, ''), 'unknown') AS unit,
                COALESCE(SUM(b.balance), 0) AS balance
            FROM balance b
            LEFT JOIN keysets k ON k.id = b.keyset
            GROUP BY COALESCE(NULLIF(k.unit, ''), 'unknown')
            ORDER BY unit
            """
        ).fetchall()
    elif "balance" in objects:
        rows = conn.execute(
            "SELECT 'sat' AS unit, COALESCE(SUM(balance), 0) AS balance FROM balance"
        ).fetchall()
    else:
        print(json.dumps({"balances": [], "initialized": False}))
        sys.exit(0)

    balances = [
        {"balance": str(int(row["balance"] or 0)), "unit": row["unit"] or "unknown"}
        for row in rows
    ]
    if not balances:
        balances = [{"balance": "0", "unit": "sat"}]

    print(json.dumps({"balances": balances, "initialized": True}))
finally:
    if conn is not None:
        conn.close()
`

const formatInteger = (value: string): string => {
  const sign = value.startsWith('-') ? '-' : ''
  const digits = sign ? value.slice(1) : value
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}

const formatBalance = ({ balance, unit }: BalanceRow): string =>
  `${formatInteger(balance)} ${unit}`

const queryMintBalances = async (
  effects: T.Effects,
): Promise<BalanceQueryResult> => {
  const mounts = sdk.Mounts.of().mountVolume({
    volumeId: 'main',
    subpath: null,
    mountpoint: dataDir,
    // SQLite WAL may need lock/shared-memory sidecar files even for read queries.
    readonly: false,
  })

  return await sdk.SubContainer.withTemp(
    effects,
    { imageId: packageId },
    mounts,
    'nutshell-balance-action',
    async (subcontainer) => {
      const output = await subcontainer.exec(
        ['python3', '-c', balanceScript],
        {
          env: {
            MINT_DB_PATH: `${dataDir}/mint/mint.sqlite3`,
          },
        },
        30_000,
      )

      if (output.exitCode !== 0) {
        const stderr = output.stderr.toString().trim()
        const stdout = output.stdout.toString().trim()
        throw new Error(stderr || stdout || 'Unable to read mint database')
      }

      return JSON.parse(output.stdout.toString()) as BalanceQueryResult
    },
  )
}

export const showMintBalance = sdk.Action.withoutInput(
  'show-mint-balance',

  async () => ({
    name: i18n('Show Mint Balance'),
    description: i18n('Show the current total mint balance from the database'),
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  async ({ effects }) => {
    const result = await queryMintBalances(effects)

    if (!result.initialized) {
      return {
        version: '1',
        title: i18n('Mint Balance'),
        message: i18n(
          'The mint database has not been initialized yet. Start the service once, then run this action again.',
        ),
        result: null,
      }
    }

    if (result.balances.length === 1) {
      const balance = formatBalance(result.balances[0])
      return {
        version: '1',
        title: i18n('Mint Balance'),
        message: i18n('Current total mint balance: ${balance}', { balance }),
        result: {
          type: 'single',
          value: balance,
          copyable: true,
          qr: false,
          masked: false,
        },
      }
    }

    return {
      version: '1',
      title: i18n('Mint Balance'),
      message: i18n('Current total mint balances from the database'),
      result: {
        type: 'group',
        value: result.balances.map((balance) => ({
          name: balance.unit,
          description: null,
          type: 'single',
          value: formatBalance(balance),
          copyable: true,
          qr: false,
          masked: false,
        })),
      },
    }
  },
)
