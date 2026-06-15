import type { T } from '@start9labs/start-sdk'

import { i18n } from '../i18n'
import { sdk } from '../sdk'
import { dataDir, packageId } from '../utils'

const { InputSpec, Value } = sdk

const modeValues = {
  inspect: 'Inspect only',
  repair: 'Clear recoverable locks',
  force: 'Force rollback melts',
} as const

type RepairMode = keyof typeof modeValues

type RepairResult = {
  adjustedKeysets: number
  committedPaidMeltProofs: number
  deletedMeltOutputs: number
  deletedPendingSwaps: number
  deletedRecoverableMeltProofs: number
  deletedUnsignedOutputs: number
  forceRolledBackMeltProofs: number
  initialized: boolean
  insertedSpentProofs: number
  mode: RepairMode
  paidMeltAmount: string
  paidMeltRows: number
  pendingMeltAmount: string
  pendingMeltRows: number
  pendingSwapAmount: string
  pendingSwapRows: number
  pendingSpentRows: number
  recoverableMeltAmount: string
  recoverableMeltRows: number
  unsignedOutputAmount: string
  unsignedOutputRows: number
  unknownMeltAmount: string
  unknownMeltRows: number
  updatedPendingMeltQuotes: number
}

const repairScript = String.raw`
import json
import os
import sqlite3
import sys

db_path = os.environ.get("MINT_DB_PATH", "/data/mint/mint.sqlite3")
mode = os.environ.get("REPAIR_MODE", "inspect")

def result_template(initialized):
    return {
        "adjustedKeysets": 0,
        "committedPaidMeltProofs": 0,
        "deletedMeltOutputs": 0,
        "deletedPendingSwaps": 0,
        "deletedRecoverableMeltProofs": 0,
        "deletedUnsignedOutputs": 0,
        "forceRolledBackMeltProofs": 0,
        "initialized": initialized,
        "insertedSpentProofs": 0,
        "mode": mode,
        "paidMeltAmount": "0",
        "paidMeltRows": 0,
        "pendingMeltAmount": "0",
        "pendingMeltRows": 0,
        "pendingSpentRows": 0,
        "pendingSwapAmount": "0",
        "pendingSwapRows": 0,
        "recoverableMeltAmount": "0",
        "recoverableMeltRows": 0,
        "unsignedOutputAmount": "0",
        "unsignedOutputRows": 0,
        "unknownMeltAmount": "0",
        "unknownMeltRows": 0,
        "updatedPendingMeltQuotes": 0,
    }

def emit(result):
    print(json.dumps(result))

if mode not in ("inspect", "repair", "force"):
    raise ValueError("Invalid repair mode")

if not os.path.exists(db_path):
    emit(result_template(False))
    sys.exit(0)

def scalar(conn, query, params=()):
    row = conn.execute(query, params).fetchone()
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

def count_amount(conn, where, join_sql=""):
    row = conn.execute(
        f"""
        SELECT COUNT(*) AS rows, COALESCE(SUM(pp.amount), 0) AS amount
        FROM proofs_pending pp
        {join_sql}
        WHERE ({where})
        """
    ).fetchone()
    return int(row["rows"] or 0), int(row["amount"] or 0)

def rowids_subquery(where, join_sql=""):
    return f"""
        SELECT pending_rowid FROM (
            SELECT pp.rowid AS pending_rowid
            FROM proofs_pending pp
            {join_sql}
            WHERE ({where})
        )
    """

conn = sqlite3.connect(db_path, timeout=30)
conn.row_factory = sqlite3.Row

try:
    objects = table_names(conn)
    required_tables = {"proofs_pending", "keysets", "proofs_used"}
    if not required_tables.issubset(objects):
        emit(result_template(False))
        sys.exit(0)

    pending_columns = column_names(conn, "proofs_pending")
    keyset_columns = column_names(conn, "keysets")
    used_columns = column_names(conn, "proofs_used")
    if not {"amount", "c", "id", "melt_quote", "secret", "y"}.issubset(
        pending_columns
    ):
        raise RuntimeError("proofs_pending table does not have the expected schema")
    if "balance" not in keyset_columns:
        raise RuntimeError("keysets table does not have the expected balance column")
    if "y" not in used_columns:
        raise RuntimeError("proofs_used table does not have the expected y column")

    has_melt_quotes = "melt_quotes" in objects
    melt_columns = column_names(conn, "melt_quotes") if has_melt_quotes else set()
    has_melt_join = has_melt_quotes and "quote" in melt_columns
    melt_join = (
        "LEFT JOIN melt_quotes mq ON mq.quote = pp.melt_quote"
        if has_melt_join
        else ""
    )

    if has_melt_join:
        if "state" in melt_columns and "paid" in melt_columns:
            melt_state = """
                CASE
                    WHEN mq.quote IS NULL THEN 'MISSING'
                    WHEN mq.state IS NULL OR TRIM(mq.state) = '' THEN
                        CASE WHEN mq.paid = 1 THEN 'PAID' ELSE 'UNKNOWN' END
                    ELSE UPPER(mq.state)
                END
            """
        elif "state" in melt_columns:
            melt_state = """
                CASE
                    WHEN mq.quote IS NULL THEN 'MISSING'
                    WHEN mq.state IS NULL OR TRIM(mq.state) = '' THEN 'UNKNOWN'
                    ELSE UPPER(mq.state)
                END
            """
        elif "paid" in melt_columns:
            melt_state = """
                CASE
                    WHEN mq.quote IS NULL THEN 'MISSING'
                    WHEN mq.paid = 1 THEN 'PAID'
                    ELSE 'UNKNOWN'
                END
            """
        else:
            melt_state = "CASE WHEN mq.quote IS NULL THEN 'MISSING' ELSE 'UNKNOWN' END"
    else:
        melt_state = "'MISSING'"

    swap_where = "(pp.melt_quote IS NULL OR pp.melt_quote = '')"
    melt_where = "(pp.melt_quote IS NOT NULL AND pp.melt_quote != '')"
    recoverable_melt_where = (
        f"{melt_where} AND ({melt_state}) IN ('MISSING', 'UNPAID')"
    )
    pending_melt_where = f"{melt_where} AND ({melt_state}) = 'PENDING'"
    paid_melt_where = f"{melt_where} AND ({melt_state}) = 'PAID'"
    unknown_melt_where = (
        f"{melt_where} AND ({melt_state}) NOT IN "
        "('MISSING', 'UNPAID', 'PENDING', 'PAID')"
    )

    pending_swap_rows, pending_swap_amount = count_amount(conn, swap_where)
    recoverable_melt_rows, recoverable_melt_amount = count_amount(
        conn, recoverable_melt_where, melt_join
    )
    pending_melt_rows, pending_melt_amount = count_amount(
        conn, pending_melt_where, melt_join
    )
    paid_melt_rows, paid_melt_amount = count_amount(conn, paid_melt_where, melt_join)
    unknown_melt_rows, unknown_melt_amount = count_amount(
        conn, unknown_melt_where, melt_join
    )
    pending_spent_rows = scalar(
        conn,
        """
        SELECT COUNT(*)
        FROM proofs_pending pp
        WHERE EXISTS (SELECT 1 FROM proofs_used pu WHERE pu.y = pp.y)
        """,
    )

    unsigned_output_rows = 0
    unsigned_output_amount = 0
    has_promises = "promises" in objects
    promise_columns = set()
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
    committed_paid_melt_proofs = 0
    deleted_melt_outputs = 0
    deleted_pending_swaps = 0
    deleted_recoverable_melt_proofs = 0
    deleted_unsigned_outputs = 0
    force_rolled_back_melt_proofs = 0
    inserted_spent_proofs = 0
    updated_pending_melt_quotes = 0

    def validate_keysets(where, join_sql=""):
        null_keyset_rows = scalar(
            conn,
            f"""
            SELECT COUNT(*)
            FROM proofs_pending pp
            {join_sql}
            WHERE ({where})
              AND (pp.id IS NULL OR pp.id = '')
            """,
        )
        if null_keyset_rows:
            raise RuntimeError("Cannot repair pending rows without keyset ids")

        missing_keyset_rows = scalar(
            conn,
            f"""
            SELECT COUNT(*)
            FROM proofs_pending pp
            {join_sql}
            WHERE ({where})
              AND NOT EXISTS (SELECT 1 FROM keysets k WHERE k.id = pp.id)
            """,
        )
        if missing_keyset_rows:
            raise RuntimeError("Cannot repair pending rows with missing keysets")

    def bump_keysets(where, join_sql=""):
        updated = 0
        adjustments = conn.execute(
            f"""
            SELECT pp.id, COALESCE(SUM(pp.amount), 0) AS amount
            FROM proofs_pending pp
            {join_sql}
            WHERE ({where})
            GROUP BY pp.id
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
            updated += 1
        return updated

    def delete_pending(where, join_sql=""):
        return conn.execute(
            f"""
            DELETE FROM proofs_pending
            WHERE rowid IN ({rowids_subquery(where, join_sql)})
            """
        ).rowcount

    def delete_unsigned_melt_outputs(where, join_sql=""):
        if not has_promises or not {"c_", "melt_quote"}.issubset(promise_columns):
            return 0
        return conn.execute(
            f"""
            DELETE FROM promises
            WHERE c_ IS NULL
              AND melt_quote IN (
                SELECT DISTINCT pp.melt_quote
                FROM proofs_pending pp
                {join_sql}
                WHERE ({where})
                  AND pp.melt_quote IS NOT NULL
                  AND pp.melt_quote != ''
              )
            """
        ).rowcount

    def insert_paid_pending_as_spent(where, join_sql=""):
        used_insert_columns = []
        used_select_columns = []
        for column in [
            "amount",
            "id",
            "c",
            "secret",
            "y",
            "witness",
            "created",
            "melt_quote",
        ]:
            if column in used_columns and column in pending_columns:
                used_insert_columns.append(column)
                if column == "created":
                    used_select_columns.append("COALESCE(pp.created, CURRENT_TIMESTAMP)")
                else:
                    used_select_columns.append(f"pp.{column}")

        if not {"amount", "c", "secret", "y"}.issubset(set(used_insert_columns)):
            raise RuntimeError("proofs_used table cannot store repaired paid proofs")

        return conn.execute(
            f"""
            INSERT OR IGNORE INTO proofs_used ({", ".join(used_insert_columns)})
            SELECT {", ".join(used_select_columns)}
            FROM proofs_pending pp
            {join_sql}
            WHERE ({where})
            """
        ).rowcount

    def rollback_pending_melt_quotes(where, join_sql=""):
        if not has_melt_join or "state" not in melt_columns:
            return 0

        set_parts = ["state = 'UNPAID'"]
        if "paid" in melt_columns:
            set_parts.append("paid = 0")
        if "paid_time" in melt_columns:
            set_parts.append("paid_time = NULL")
        if "fee_paid" in melt_columns:
            set_parts.append("fee_paid = 0")
        if "proof" in melt_columns:
            set_parts.append("proof = NULL")

        return conn.execute(
            f"""
            UPDATE melt_quotes
            SET {", ".join(set_parts)}
            WHERE quote IN (
                SELECT DISTINCT pp.melt_quote
                FROM proofs_pending pp
                {join_sql}
                WHERE ({where})
            )
            """
        ).rowcount

    repair_modes = ("repair", "force")
    has_repairable_rows = (
        pending_swap_rows
        or recoverable_melt_rows
        or paid_melt_rows
        or unsigned_output_rows
        or (mode == "force" and pending_melt_rows)
    )

    if mode in repair_modes and has_repairable_rows:
        release_parts = [swap_where, recoverable_melt_where]
        if mode == "force":
            release_parts.append(pending_melt_where)
        release_where = "(" + ") OR (".join(release_parts) + ")"
        paid_already_used_where = (
            f"{paid_melt_where} "
            "AND EXISTS (SELECT 1 FROM proofs_used pu WHERE pu.y = pp.y)"
        )

        if pending_swap_rows or recoverable_melt_rows or (
            mode == "force" and pending_melt_rows
        ):
            validate_keysets(release_where, melt_join)
        if paid_melt_rows:
            validate_keysets(paid_melt_where, melt_join)

        conn.execute("BEGIN")
        try:
            if mode == "force" and pending_melt_rows:
                updated_pending_melt_quotes = rollback_pending_melt_quotes(
                    pending_melt_where, melt_join
                )

            if paid_melt_rows:
                adjusted_keysets += bump_keysets(paid_already_used_where, melt_join)
                inserted_spent_proofs = insert_paid_pending_as_spent(
                    paid_melt_where, melt_join
                )
                committed_paid_melt_proofs = delete_pending(
                    paid_melt_where, melt_join
                )

            if pending_swap_rows or recoverable_melt_rows or (
                mode == "force" and pending_melt_rows
            ):
                deleted_melt_outputs += delete_unsigned_melt_outputs(
                    release_where, melt_join
                )
                adjusted_keysets += bump_keysets(release_where, melt_join)
                deleted_release_rows = delete_pending(release_where, melt_join)
                deleted_pending_swaps = pending_swap_rows
                deleted_recoverable_melt_proofs = recoverable_melt_rows
                if mode == "force":
                    force_rolled_back_melt_proofs = pending_melt_rows
                if deleted_release_rows != (
                    deleted_pending_swaps
                    + deleted_recoverable_melt_proofs
                    + force_rolled_back_melt_proofs
                ):
                    raise RuntimeError("Pending proof repair row count changed")

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
        "committedPaidMeltProofs": committed_paid_melt_proofs,
        "deletedMeltOutputs": deleted_melt_outputs,
        "deletedPendingSwaps": deleted_pending_swaps,
        "deletedRecoverableMeltProofs": deleted_recoverable_melt_proofs,
        "deletedUnsignedOutputs": deleted_unsigned_outputs,
        "forceRolledBackMeltProofs": force_rolled_back_melt_proofs,
        "initialized": True,
        "insertedSpentProofs": inserted_spent_proofs,
        "mode": mode,
        "paidMeltAmount": str(paid_melt_amount),
        "paidMeltRows": paid_melt_rows,
        "pendingMeltAmount": str(pending_melt_amount),
        "pendingMeltRows": pending_melt_rows,
        "pendingSpentRows": pending_spent_rows,
        "pendingSwapAmount": str(pending_swap_amount),
        "pendingSwapRows": pending_swap_rows,
        "recoverableMeltAmount": str(recoverable_melt_amount),
        "recoverableMeltRows": recoverable_melt_rows,
        "unsignedOutputAmount": str(unsigned_output_amount),
        "unsignedOutputRows": unsigned_output_rows,
        "unknownMeltAmount": str(unknown_melt_amount),
        "unknownMeltRows": unknown_melt_rows,
        "updatedPendingMeltQuotes": updated_pending_melt_quotes,
    })
finally:
    conn.close()
`

export const inputSpec = InputSpec.of({
  mode: Value.select({
    name: i18n('Repair Mode'),
    description: i18n(
      'Inspect first. Repair clears recoverable locks; force only after confirming a Lightning melt failed.',
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
    description: i18n('Pending proofs that already have a spent record'),
    type: 'single' as const,
    value: formatInteger(result.pendingSpentRows),
    copyable: false,
    qr: false,
    masked: false,
  },
  {
    name: i18n('Recoverable melt proofs'),
    description: i18n(
      'Lightning melt locks tied to unpaid or missing quotes',
    ),
    type: 'single' as const,
    value: `${formatInteger(result.recoverableMeltRows)} (${formatInteger(
      result.recoverableMeltAmount,
    )} total)`,
    copyable: false,
    qr: false,
    masked: false,
  },
  {
    name: i18n('Active pending melt proofs'),
    description: i18n(
      'Lightning melt locks still marked pending; force rollback changes these to unpaid',
    ),
    type: 'single' as const,
    value: `${formatInteger(result.pendingMeltRows)} (${formatInteger(
      result.pendingMeltAmount,
    )} total)`,
    copyable: false,
    qr: false,
    masked: false,
  },
  {
    name: i18n('Paid melt proofs'),
    description: i18n(
      'Already-paid melt locks that repair mode records as spent',
    ),
    type: 'single' as const,
    value: `${formatInteger(result.paidMeltRows)} (${formatInteger(
      result.paidMeltAmount,
    )} total)`,
    copyable: false,
    qr: false,
    masked: false,
  },
  {
    name: i18n('Unknown melt proofs'),
    description: i18n('Lightning melt locks with an unrecognized quote state'),
    type: 'single' as const,
    value: `${formatInteger(result.unknownMeltRows)} (${formatInteger(
      result.unknownMeltAmount,
    )} total)`,
    copyable: false,
    qr: false,
    masked: false,
  },
  {
    name: i18n('Unsigned orphan outputs'),
    description: i18n('Stored but unsigned outputs removed during repair'),
    type: 'single' as const,
    value: `${formatInteger(result.unsignedOutputRows)} (${formatInteger(
      result.unsignedOutputAmount,
    )} total)`,
    copyable: false,
    qr: false,
    masked: false,
  },
  {
    name: i18n('Rows repaired'),
    description: i18n('Rows changed when repair or force mode is selected'),
    type: 'single' as const,
    value: [
      `${formatInteger(result.deletedPendingSwaps)} swap locks`,
      `${formatInteger(result.deletedRecoverableMeltProofs)} recoverable melt locks`,
      `${formatInteger(result.forceRolledBackMeltProofs)} forced melt locks`,
      `${formatInteger(result.committedPaidMeltProofs)} paid melt locks`,
      `${formatInteger(
        result.deletedUnsignedOutputs + result.deletedMeltOutputs,
      )} unsigned outputs`,
      `${formatInteger(result.insertedSpentProofs)} spent inserts`,
      `${formatInteger(result.updatedPendingMeltQuotes)} quotes`,
      `${formatInteger(result.adjustedKeysets)} keysets`,
    ].join(', '),
    copyable: false,
    qr: false,
    masked: false,
  },
]

export const repairPendingSwaps = sdk.Action.withInput(
  'repair-pending-swaps',

  async () => ({
    name: i18n('Repair Pending Proofs'),
    description: i18n(
      'Inspect and repair stale pending proof locks after an interruption',
    ),
    warning: i18n(
      'Stop Nutshell and make a backup before repair mode. Force rollback marks pending Lightning melts as unpaid; use it only after confirming the outgoing payment failed.',
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
        title: i18n('Pending Proof Repair'),
        message: i18n(
          'The mint database has not been initialized yet. Start the service once, then run this action again.',
        ),
        result: null,
      }
    }

    const foundRepairable =
      result.pendingSwapRows > 0 ||
      result.recoverableMeltRows > 0 ||
      result.paidMeltRows > 0 ||
      result.unsignedOutputRows > 0
    const foundForceOnly = result.pendingMeltRows > 0
    const repaired =
      result.deletedPendingSwaps > 0 ||
      result.deletedRecoverableMeltProofs > 0 ||
      result.committedPaidMeltProofs > 0 ||
      result.forceRolledBackMeltProofs > 0 ||
      result.deletedUnsignedOutputs > 0 ||
      result.deletedMeltOutputs > 0
    const message =
      mode === 'inspect'
        ? foundRepairable
          ? i18n(
              'Inspect found pending proof data that repair mode can clear.',
            )
          : foundForceOnly
            ? i18n(
                'Inspect found active pending Lightning melts. Start Nutshell to reconcile them, or use force rollback only if the payment failed.',
              )
            : result.unknownMeltRows > 0
              ? i18n(
                  'Inspect found pending melt proofs with an unknown quote state. They were left unchanged.',
                )
              : i18n('No stale pending proof data was found.')
        : repaired
          ? mode === 'force'
            ? i18n('Pending Lightning melt locks were force rolled back.')
            : i18n('Recoverable pending proof data was repaired.')
          : foundForceOnly
            ? i18n(
                'No recoverable data was repaired. Active pending Lightning melts remain.',
              )
            : i18n('No stale pending proof data was found.')

    return {
      version: '1',
      title: i18n('Pending Proof Repair'),
      message,
      result: {
        type: 'group',
        value: resultRows(result),
      },
    }
  },
)
