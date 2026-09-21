#!/usr/bin/env python3
"""Reconcile a mint's reported balance against its signature ledger.

The balance a mint reports (`keysets.balance`, which the StartOS "Show Mint
Balance" action sums) is an incremental counter: every issuance, pending-lock and
redemption bumps it. A bookkeeping bug can therefore drive it away from reality
in either direction -- including negative -- without a single satoshi being lost.

The ground truth is the `balance` SQL view, which derives the outstanding ecash
per keyset from the ledger of what was actually signed and actually spent:

    issued   = SUM(promises.amount) WHERE c_ IS NOT NULL   -- blind signatures given out
    redeemed = SUM(proofs_used.amount)                     -- proofs spent back
    balance  = issued - redeemed

For a mint at rest the two must agree, offset by anything currently locked:

    keysets.balance  ==  view balance  -  pending proofs

This script reports both sides, explains any gap, and looks for the fingerprints
the melt "stale FAILED" race leaves behind. It is READ-ONLY unless you pass
--fix-counter, and it never touches promises, proofs_used or proofs_pending, so
it cannot invalidate anyone's ecash.

Stop the mint before running it: the identity above only holds at rest.

Usage:
    python3 scripts/reconcile_mint_balance.py [--db PATH] [--json] [--fix-counter]
"""

import argparse
import json
import os
import sqlite3
import sys
from typing import Any, Dict, List

DEFAULT_DB = "/data/mint/mint.sqlite3"


def _rows(conn: sqlite3.Connection, query: str, params: tuple = ()) -> List[Any]:
    return conn.execute(query, params).fetchall()


def _objects(conn: sqlite3.Connection) -> set:
    return {
        r["name"]
        for r in _rows(
            conn, "SELECT name FROM sqlite_master WHERE type IN ('table','view')"
        )
    }


def collect(conn: sqlite3.Connection) -> Dict[str, Any]:
    objects = _objects(conn)
    missing = {"keysets", "promises", "proofs_used"} - objects
    if missing:
        raise SystemExit(f"database is missing expected tables: {sorted(missing)}")

    keysets = {
        r["id"]: {
            "id": r["id"],
            "unit": r["unit"] or "unknown",
            "active": bool(r["active"]),
            "counter": int(r["balance"] or 0),
            "fees_paid": int(r["fees_paid"] or 0),
        }
        for r in _rows(conn, "SELECT * FROM keysets")
    }

    # Ground truth, straight from the signature ledger. Computed here rather
    # than read from the `balance` view so the script still works if the view
    # was dropped by a partial migration.
    issued = {
        r["id"]: int(r["s"] or 0)
        for r in _rows(
            conn,
            "SELECT id, SUM(amount) AS s FROM promises"
            " WHERE amount > 0 AND c_ IS NOT NULL GROUP BY id",
        )
    }
    redeemed = {
        r["id"]: int(r["s"] or 0)
        for r in _rows(
            conn,
            "SELECT id, SUM(amount) AS s FROM proofs_used"
            " WHERE amount > 0 GROUP BY id",
        )
    }
    pending = {}
    if "proofs_pending" in objects:
        pending = {
            r["id"]: int(r["s"] or 0)
            for r in _rows(
                conn,
                "SELECT id, SUM(amount) AS s FROM proofs_pending"
                " WHERE amount > 0 GROUP BY id",
            )
        }

    for kid in set(issued) | set(redeemed) | set(pending):
        keysets.setdefault(
            kid,
            {
                "id": kid,
                "unit": "unknown",
                "active": False,
                "counter": 0,
                "fees_paid": 0,
            },
        )

    for kid, ks in keysets.items():
        ks["issued"] = issued.get(kid, 0)
        ks["redeemed"] = redeemed.get(kid, 0)
        ks["pending"] = pending.get(kid, 0)
        ks["outstanding"] = ks["issued"] - ks["redeemed"]
        # what the incremental counter should read for this keyset
        ks["expected_counter"] = ks["outstanding"] - ks["pending"]
        ks["drift"] = ks["counter"] - ks["expected_counter"]

    return {"keysets": keysets, "objects": objects}


def find_melt_anomalies(conn: sqlite3.Connection) -> Dict[str, Any]:
    """Look for the traces the melt stale-FAILED race leaves behind."""
    objects = _objects(conn)
    out: Dict[str, Any] = {}
    if "melt_quotes" not in objects:
        return out

    cols = {r["name"] for r in _rows(conn, "PRAGMA table_info(melt_quotes)")}
    state_col = "state" if "state" in cols else None
    if not state_col:
        return out

    # Proofs spent against a melt quote that is not recorded as paid. The race
    # released the proofs, they were re-spent elsewhere, and the quote never
    # reached PAID -- while the Lightning payment may well have settled.
    out["spent_proofs_on_unpaid_quotes"] = [
        dict(r)
        for r in _rows(
            conn,
            """
            SELECT q.quote, q.state, q.amount, q.fee_reserve, q.request,
                   COUNT(p.y) AS n_proofs, SUM(p.amount) AS proof_amount
            FROM proofs_used p
            JOIN melt_quotes q ON q.quote = p.melt_quote
            WHERE q.state != 'PAID'
            GROUP BY q.quote
            ORDER BY proof_amount DESC
            """,
        )
    ]

    # Quotes left PENDING with no proofs locked against them: the proofs were
    # released out from under an in-flight payment.
    pending_clause = (
        "AND q.quote NOT IN (SELECT DISTINCT melt_quote FROM proofs_pending"
        " WHERE melt_quote IS NOT NULL)"
        if "proofs_pending" in objects
        else ""
    )
    out["pending_quotes_without_locked_proofs"] = [
        dict(r)
        for r in _rows(
            conn,
            f"""
            SELECT q.quote, q.state, q.amount, q.fee_reserve, q.request
            FROM melt_quotes q
            WHERE q.state = 'PENDING' {pending_clause}
            ORDER BY q.amount DESC
            """,
        )
    ]
    return out


def report(data: Dict[str, Any], anomalies: Dict[str, Any]) -> int:
    keysets = data["keysets"]
    by_unit: Dict[str, Dict[str, int]] = {}
    for ks in keysets.values():
        u = by_unit.setdefault(
            ks["unit"],
            {"counter": 0, "outstanding": 0, "pending": 0, "expected": 0, "drift": 0},
        )
        u["counter"] += ks["counter"]
        u["outstanding"] += ks["outstanding"]
        u["pending"] += ks["pending"]
        u["expected"] += ks["expected_counter"]
        u["drift"] += ks["drift"]

    print("Per-keyset\n")
    header = (
        f"{'keyset':<18}{'unit':<7}{'act':<5}{'counter':>12}"
        f"{'issued':>12}{'redeemed':>12}{'pending':>10}{'outstanding':>13}{'drift':>10}"
    )
    print(header)
    print("-" * len(header))
    for ks in sorted(keysets.values(), key=lambda k: (k["unit"], k["id"])):
        print(
            f"{ks['id'][:16]:<18}{ks['unit']:<7}{'y' if ks['active'] else 'n':<5}"
            f"{ks['counter']:>12}{ks['issued']:>12}{ks['redeemed']:>12}"
            f"{ks['pending']:>10}{ks['outstanding']:>13}{ks['drift']:>10}"
        )

    print("\nPer-unit totals\n")
    for unit, u in sorted(by_unit.items()):
        print(f"  {unit}")
        print(f"    reported balance (counter) : {u['counter']:>14,}")
        print(f"    outstanding ecash (ledger) : {u['outstanding']:>14,}"
              "   <- your real liability")
        print(f"    locked in flight (pending) : {u['pending']:>14,}")
        print(f"    counter should read        : {u['expected']:>14,}")
        print(f"    counter drift              : {u['drift']:>14,}")

    print()
    drifted = any(u["drift"] for u in by_unit.values())
    negative_liability = any(u["outstanding"] < 0 for u in by_unit.values())

    if negative_liability:
        print("!! Outstanding ecash is NEGATIVE in the ledger itself: more value was")
        print("   redeemed than was ever signed. That is not counter drift -- it means")
        print("   proofs_used contains entries with no matching issuance (a restored or")
        print("   merged database, or a keyset whose promises were pruned). Do not run")
        print("   --fix-counter; investigate first.")
    elif drifted:
        print("Counter drift detected, but the ledger itself is consistent.")
        print("Your real liability is the 'outstanding ecash' figure above; the negative")
        print("number your UI shows is the drifted counter, not lost money.")
        print("Re-run with --fix-counter to reset the counter to the ledger.")
    else:
        print("Counter matches the ledger. No reconciliation needed.")

    total_spent_on_unpaid = sum(
        int(r["proof_amount"] or 0)
        for r in anomalies.get("spent_proofs_on_unpaid_quotes", [])
    )
    if total_spent_on_unpaid:
        rows = anomalies["spent_proofs_on_unpaid_quotes"]
        print()
        print(f"!! {len(rows)} melt quote(s) hold spent proofs but are not marked PAID")
        print(f"   ({total_spent_on_unpaid:,} in proof value).")
        print("   Check each invoice against your Lightning node: any that DID settle")
        print("   is a real loss of that amount, and its bolt11 names the payee.")
        for r in rows[:10]:
            print(
                f"     {r['quote']}  state={r['state']}  amount={r['amount']}  "
                f"proofs={r['proof_amount']}"
            )
        if len(rows) > 10:
            print(f"     ... and {len(rows) - 10} more")

    orphan_pending = anomalies.get("pending_quotes_without_locked_proofs", [])
    if orphan_pending:
        print()
        print(f"!! {len(orphan_pending)} melt quote(s) are PENDING with no proofs locked.")
        print("   Their proofs were released while a payment was in flight.")
        for r in orphan_pending[:10]:
            print(f"     {r['quote']}  amount={r['amount']}")

    print()
    print("Next: compare 'outstanding ecash' against your Lightning node balance.")
    print("A node balance below it is the size of the real shortfall.")
    return 0


def fix_counter(conn: sqlite3.Connection, data: Dict[str, Any]) -> None:
    changed = 0
    for ks in data["keysets"].values():
        if ks["drift"] == 0:
            continue
        if ks["id"] not in {
            r["id"] for r in _rows(conn, "SELECT id FROM keysets")
        }:
            print(f"  skipping unknown keyset {ks['id']} (no keysets row)")
            continue
        conn.execute(
            "UPDATE keysets SET balance = ? WHERE id = ?",
            (ks["expected_counter"], ks["id"]),
        )
        print(
            f"  {ks['id'][:16]}: {ks['counter']} -> {ks['expected_counter']}"
            f" (drift {ks['drift']:+})"
        )
        changed += 1
    conn.commit()
    print(f"\nUpdated {changed} keyset counter(s). No ecash was modified.")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", default=os.environ.get("MINT_DB_PATH", DEFAULT_DB))
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument(
        "--fix-counter",
        action="store_true",
        help="reset keysets.balance to the ledger value (only safe with the mint stopped)",
    )
    args = ap.parse_args()

    if not os.path.exists(args.db):
        raise SystemExit(f"no database at {args.db}")

    mode = "" if args.fix_counter else "?mode=ro"
    conn = sqlite3.connect(f"file:{args.db}{mode}", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        data = collect(conn)
        anomalies = find_melt_anomalies(conn)

        if args.json:
            print(
                json.dumps(
                    {
                        "keysets": list(data["keysets"].values()),
                        "anomalies": anomalies,
                    },
                    indent=2,
                    default=str,
                )
            )
        else:
            report(data, anomalies)

        if args.fix_counter:
            if any(ks["outstanding"] < 0 for ks in data["keysets"].values()):
                raise SystemExit(
                    "\nRefusing to fix: the ledger itself shows negative outstanding"
                    " ecash. Investigate before overwriting the counter."
                )
            print("\nApplying counter fix...")
            fix_counter(conn, data)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
