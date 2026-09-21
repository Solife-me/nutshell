"""Two melt quotes for one invoice must not be payable concurrently.

The duplicate-payment guard used to match only on `checking_id`. That is not
enough: the two paths that create a melt quote assign different ids to the same
invoice -- `create_internal_melt_quote` copies the mint quote's checking_id,
while the backend path uses the payment hash. On any backend whose invoice ids
are not the payment hash, one invoice can therefore yield two quotes with
different checking_ids, and the mint would happily drive both to PENDING and pay
twice.

The guard now matches on `request` as well, so any quote that would settle the
same payment blocks the others.
"""

import pytest

from cashu.core.base import MeltQuote, MeltQuoteState
from cashu.core.errors import InvoiceAlreadyPaidError, QuotePendingError
from cashu.mint.ledger import Ledger

REQUEST = "lnbcrt620n1pn0r3vepp5zljn7g09fsyeahl4rnhuy0xax2puhua5r3gspt7ttlfrley6val"


def _quote(quote_id: str, checking_id: str) -> MeltQuote:
    return MeltQuote(
        quote=quote_id,
        method="bolt11",
        request=REQUEST,
        checking_id=checking_id,
        unit="sat",
        amount=62,
        fee_reserve=2,
        state=MeltQuoteState.unpaid,
    )


async def _store_both(ledger: Ledger) -> tuple[MeltQuote, MeltQuote]:
    # same invoice, different checking_ids (backend path vs internal path)
    external = _quote("quote-external", "payment-hash-aaaa")
    internal = _quote("quote-internal", "mint-quote-id-bbbb")
    await ledger.crud.store_melt_quote(quote=external, db=ledger.db)
    await ledger.crud.store_melt_quote(quote=internal, db=ledger.db)
    return external, internal


@pytest.mark.asyncio
async def test_pending_quote_blocks_sibling_with_other_checking_id(ledger: Ledger):
    external, internal = await _store_both(ledger)

    await ledger.db_write._set_melt_quote_pending(external)

    with pytest.raises(QuotePendingError):
        await ledger.db_write._set_melt_quote_pending(internal)


@pytest.mark.asyncio
async def test_paid_quote_blocks_sibling_with_other_checking_id(ledger: Ledger):
    external, internal = await _store_both(ledger)

    external.state = MeltQuoteState.paid
    await ledger.crud.update_melt_quote(quote=external, db=ledger.db)

    with pytest.raises(InvoiceAlreadyPaidError):
        await ledger.db_write._set_melt_quote_pending(internal)


@pytest.mark.asyncio
async def test_cannot_create_a_new_quote_for_an_in_flight_invoice(ledger: Ledger):
    external = _quote("quote-external", "payment-hash-aaaa")
    await ledger.crud.store_melt_quote(quote=external, db=ledger.db)
    await ledger.db_write._set_melt_quote_pending(external)

    # a second quote for the same invoice must not even be created while the
    # first one is in flight, whatever checking_id the backend hands us
    with pytest.raises(QuotePendingError):
        await ledger.db_write._store_melt_quote(
            _quote("quote-internal", "mint-quote-id-bbbb")
        )


@pytest.mark.asyncio
async def test_unrelated_invoice_is_unaffected(ledger: Ledger):
    external = _quote("quote-external", "payment-hash-aaaa")
    await ledger.crud.store_melt_quote(quote=external, db=ledger.db)
    await ledger.db_write._set_melt_quote_pending(external)

    other = MeltQuote(
        quote="quote-other-invoice",
        method="bolt11",
        request=REQUEST + "different",
        checking_id="payment-hash-cccc",
        unit="sat",
        amount=62,
        fee_reserve=2,
        state=MeltQuoteState.unpaid,
    )
    await ledger.db_write._store_melt_quote(other)
    pending = await ledger.db_write._set_melt_quote_pending(other)
    assert pending.state == MeltQuoteState.pending
