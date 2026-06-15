import type { T } from '@start9labs/start-sdk'

import { i18n } from '../i18n'
import { sdk } from '../sdk'
import { dataDir, packageId } from '../utils'

const { InputSpec, Value } = sdk

const modeValues = {
  inspect: 'Inspect only',
  repair: 'Clear stale swap locks',
} as const

type RepairMode = keyof typeof modeValues

type RepairResult = {
  adjustedKeysets: number
  deletedPendingSwaps: number
  deletedUnsignedOutputs: number
  initialized: boolean
  mode: RepairMode
  pendingMelts: number
  pendingSwapAmount: string
  pendingSwapRows: number
  pendingSwapSpentRows: number
  unsignedOutputAmount: string
  unsignedOutputRows: number
}

const repairScript = String.raw`
import json
import os
import sqlite3
import sys

db_path = os.environ.get("MINT_DB_PATH", "/data/mint/mint.sqlite3")
mode = os.environ.get("REPAIR_MODE", "inspect")

def emit(result):
    print(json.dumps(result))

if mode not in ("inspect", "repair"):
    raise ValueError("Invalid repair mode")

if not os.path.exists(db_path):
    emit({
        "adjustedKeysets": 0,
        "deletedPendingSwaps": 0,
        "deletedUnsignedOutputs": 0,
        "initialized": False,
        "mode": mode,
        "pendingMelts": 0,
        "pendingSwapAmount": "0",
        "pendingSwapRows": 0,
        "pendingSwapSpentRows": 0,
        "unsignedOutputAmount": "0",
        "unsignedOutputRows": 0,
    })
    sys.exit(0)

def scalar(conn, query):
    row = conn.execute(query).fetchone()
    return int(row[0] or 0)

def table_names(conn):
    return {
        row["name"]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')"
        )
    }

def column_names(conn, table):
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}

conn = sqlite3.connect(db_path, timeout=30)
conn.row_factory = sqlite3.Row

try:
    objects = table_names(conn)
    required_tables = {"proofs_pending", "keysets", "proofs_used"}
    if not required_tables.issubset(objects):
        emit({
            "adjustedKeysets": 0,
            "deletedPendingSwaps": 0,
            "deletedUnsignedOutputs": 0,
            "initialized": False,
            "mode": mode,
            "pendingMelts": 0,
            "pendingSwapAmount": "0",
            "pendingSwapRows": 0,
            "pendingSwapSpentRows": 0,
            "unsignedOutputAmount": "0",
            "unsignedOutputRows": 0,
        })
        sys.exit(0)

    pending_columns = column_names(conn, "proofs_pending")
    keyset_columns = column_names(conn, "keysets")
    if not {"amount", "id", "melt_quote", "y"}.issubset(pending_columns):
        raise RuntimeError("proofs_pending table does not have the expected schema")
    if "balance" not in keyset_columns:
        raise RuntimeError("keysets table does not have the expected balance column")

    pending_swap_rows = scalar(
        conn,
        """
        SELECT COUNT(*)
        FROM proofs_pending
        WHERE melt_quote IS NULL
        """,
    )
    pending_swap_amount = scalar(
        conn,
        """
        SELECT COALESCE(SUM(amount), 0)
        FROM proofs_pending
        WHERE melt_quote IS NULL
        """,
    )
    pending_swap_spent_rows = scalar(
        conn,
        """
        SELECT COUNT(*)
        FROM proofs_pending pp
        WHERE pp.melt_quote IS NULL
          AND EXISTS (SELECT 1 FROM proofs_used pu WHERE pu.y = pp.y)
        """,
    )
    pending_melts = scalar(
        conn,
        """
        SELECT COUNT(*)
        FROM proofs_pending
        WHERE melt_quote IS NOT NULL
        """,
    )

    unsigned_output_rows = 0
    unsigned_output_amount = 0
    has_promises = "promises" in objects
    if has_promises:
        promise_columns = column_names(conn, "promises")
        if {
            "amount",
            "c_",
            "mint_quote",
            "melt_quote",
            "swap_id",
        }.issubset(promise_columns):
            unsigned_where = """
                c_ IS NULL
                AND mint_quote IS NULL
                AND melt_quote IS NULL
                AND swap_id IS NULL
            """
            unsigned_output_rows = scalar(
                conn,
                f"SELECT COUNT(*) FROM promises WHERE {unsigned_where}",
            )
            unsigned_output_amount = scalar(
                conn,
                f"SELECT COALESCE(SUM(amount), 0) FROM promises WHERE {unsigned_where}",
            )
        else:
            has_promises = False

    adjusted_keysets = 0
    deleted_pending_swaps = 0
    deleted_unsigned_outputs = 0

    if mode == "repair" and (pending_swap_rows or unsigned_output_rows):
        null_keyset_rows = scalar(
            conn,
            """
            SELECT COUNT(*)
            FROM proofs_pending
            WHERE melt_quote IS NULL AND id IS NULL
            """,
        )
        if null_keyset_rows:
            raise RuntimeError("Cannot repair pending swap rows without keyset ids")

        missing_keyset_rows = scalar(
            conn,
            """
            SELECT COUNT(*)
            FROM proofs_pending pp
            WHERE pp.melt_quote IS NULL
              AND NOT EXISTS (SELECT 1 FROM keysets k WHERE k.id = pp.id)
            """,
        )
        if missing_keyset_rows:
            raise RuntimeError("Cannot repair pending swap rows with missing keysets")

        conn.execute("BEGIN")
        try:
            adjustments = conn.execute(
                """
                SELECT id, COALESCE(SUM(amount), 0) AS amount
                FROM proofs_pending
                WHERE melt_quote IS NULL
                GROUP BY id
                """
            ).fetchall()
            for row in adjustments:
                conn.execute(
                    """
                    UPDATE keysets
                    SET balance = balance + ?
                    WHERE id = ?
                    """,
                    (int(row["amount"] or 0), row["id"]),
                )
                adjusted_keysets += 1

            deleted_pending_swaps = conn.execute(
                """
                DELETE FROM proofs_pending
                WHERE melt_quote IS NULL
                """
            ).rowcount

            if has_promises:
                deleted_unsigned_outputs = conn.execute(
                    """
                    DELETE FROM promises
                    WHERE c_ IS NULL
                      AND mint_quote IS NULL
                      AND melt_quote IS NULL
                      AND swap_id IS NULL
                    """
                ).rowcount

            conn.commit()
        except Exception:
            conn.rollback()
            raise

    emit({
        "adjustedKeysets": adjusted_keysets,
        "deletedPendingSwaps": deleted_pending_swaps,
        "deletedUnsignedOutputs": deleted_unsigned_outputs,
        "initialized": True,
        "mode": mode,
        "pendingMelts": pending_melts,
        "pendingSwapAmount": str(pending_swap_amount),
        "pendingSwapRows": pending_swap_rows,
        "pendingSwapSpentRows": pending_swap_spent_rows,
        "unsignedOutputAmount": str(unsigned_output_amount),
        "unsignedOutputRows": unsigned_output_rows,
    })
finally:
    conn.close()
`

export const inputSpec = InputSpec.of({
  mode: Value.select({
    name: i18n('Repair Mode'),
    description: i18n(
      'Inspect first, then run again to clear stale swap locks',
    ),
    default: 'inspect',
    values: modeValues,
  }),
})

const formatInteger = (value: string | number): string => {
  const text = String(value)
  const sign = text.startsWith('-') ? '-' : ''
  const digits = sign ? text.slice(1) : text
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}

const runRepair = async (
  effects: T.Effects,
  mode: RepairMode,
): Promise<RepairResult> => {
  const status = await sdk.getStatus(effects).once()
  if (status?.desired.main !== 'stopped') {
    throw new Error('Stop Nutshell before running this repair')
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
    'nutshell-repair-pending-swaps-action',
    async (subcontainer) => {
      const output = await subcontainer.exec(
        ['python3', '-c', repairScript],
        {
          env: {
            MINT_DB_PATH: `${dataDir}/mint/mint.sqlite3`,
            REPAIR_MODE: mode,
          },
        },
        30_000,
      )

      if (output.exitCode !== 0) {
        const stderr = output.stderr.toString().trim()
        const stdout = output.stdout.toString().trim()
        throw new Error(stderr || stdout || 'Unable to repair mint database')
      }

      return JSON.parse(output.stdout.toString()) as RepairResult
    },
  )
}

const resultRows = (result: RepairResult) => [
  {
    name: i18n('Pending swap proofs'),
    description: i18n('Swap or receive proofs currently locked as pending'),
    type: 'single' as const,
    value: `${formatInteger(result.pendingSwapRows)} (${formatInteger(
      result.pendingSwapAmount,
    )} total)`,
    copyable: false,
    qr: false,
    masked: false,
  },
  {
    name: i18n('Already-spent pending proofs'),
    description: i18n('Pending swap proofs that were also marked spent'),
    type: 'single' as const,
    value: formatInteger(result.pendingSwapSpentRows),
    copyable: false,
    qr: false,
    masked: false,
  },
  {
    name: i18n('Unsigned orphan outputs'),
    description: i18n('Stored but unsigned swap outputs removed during repair'),
    type: 'single' as const,
    value: `${formatInteger(result.unsignedOutputRows)} (${formatInteger(
      result.unsignedOutputAmount,
    )} total)`,
    copyable: false,
    qr: false,
    masked: false,
  },
  {
    name: i18n('Pending melt proofs left alone'),
    description: i18n('Lightning melt proofs are not changed by this action'),
    type: 'single' as const,
    value: formatInteger(result.pendingMelts),
    copyable: false,
    qr: false,
    masked: false,
  },
  {
    name: i18n('Rows repaired'),
    description: i18n('Rows cleared when repair mode is selected'),
    type: 'single' as const,
    value: `${formatInteger(
      result.deletedPendingSwaps,
    )} pending proofs, ${formatInteger(
      result.deletedUnsignedOutputs,
    )} unsigned outputs, ${formatInteger(result.adjustedKeysets)} keysets`,
    copyable: false,
    qr: false,
    masked: false,
  },
]

export const repairPendingSwaps = sdk.Action.withInput(
  'repair-pending-swaps',

  async () => ({
    name: i18n('Repair Pending Swaps'),
    description: i18n(
      'Clear stale receive or swap locks after an interruption',
    ),
    warning: i18n(
      'Stop Nutshell and make a backup before running repair mode. Pending Lightning melts are left unchanged.',
    ),
    allowedStatuses: 'only-stopped',
    group: i18n('Maintenance'),
    visibility: 'enabled',
  }),

  inputSpec,

  async () => ({
    mode: 'inspect' as const,
  }),

  async ({ effects, input }) => {
    const mode = input.mode as RepairMode
    const result = await runRepair(effects, mode)

    if (!result.initialized) {
      return {
        version: '1',
        title: i18n('Pending Swap Repair'),
        message: i18n(
          'The mint database has not been initialized yet. Start the service once, then run this action again.',
        ),
        result: null,
      }
    }

    const foundIssue =
      result.pendingSwapRows > 0 || result.unsignedOutputRows > 0
    const message =
      mode === 'inspect'
        ? foundIssue
          ? i18n(
              'Inspect found stale pending swap data. Run repair mode to clear it.',
            )
          : i18n('No stale pending swap data was found.')
        : foundIssue
          ? i18n('Stale pending swap data was repaired.')
          : i18n('No stale pending swap data was found.')

    return {
      version: '1',
      title: i18n('Pending Swap Repair'),
      message,
      result: {
        type: 'group',
        value: resultRows(result),
      },
    }
  },
)
