from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from cashu.core.base import Amount, BlindedMessage, Method, MintQuoteState, Unit
from cashu.core.crypto.b_dhke import step1_alice
from cashu.core.errors import TransactionError
from cashu.core.models import (
    PostMeltQuoteRequest,
    PostMintQuoteBolt12Request,
)
from cashu.lightning.base import (
    Bolt12InvoiceQuoteResponse,
    OfferResponse,
    OfferStatusResponse,
)
from cashu.mint.ledger import Ledger


def add_bolt12_backend(ledger: Ledger, backend: SimpleNamespace) -> None:
    ledger.backends = {
        **ledger.backends,
        Method.bolt12: {Unit.sat: backend},  # type: ignore[dict-item]
    }


def output(ledger: Ledger, amount: int, secret: str) -> BlindedMessage:
    B_, _ = step1_alice(secret)
    return BlindedMessage(
        amount=amount,
        B_=B_.format().hex(),
        id=ledger.keyset.id,
    )


@pytest.mark.asyncio
async def test_bolt12_mint_tracks_partial_and_cumulative_issuance(
    ledger: Ledger, monkeypatch: pytest.MonkeyPatch
):
    backend = SimpleNamespace(
        supports_description=True,
        create_offer=AsyncMock(
            return_value=OfferResponse(
                ok=True,
                checking_id="offer-id",
                payment_request="lno1offer",
            )
        ),
        get_offer_status=AsyncMock(
            return_value=OfferStatusResponse(
                amount_paid=Amount(Unit.sat, 12),
            )
        ),
    )
    add_bolt12_backend(ledger, backend)
    monkeypatch.setattr(
        ledger,
        "_verify_mint_quote_witness",
        lambda quote, outputs, signature: True,
    )

    response = await ledger.mint_quote_bolt12(
        PostMintQuoteBolt12Request(
            unit="sat",
            description="StartOS mint",
            pubkey=ledger.pubkey.format().hex(),
        )
    )
    assert response.amount is None
    assert response.amount_paid == 0
    assert response.amount_issued == 0
    backend.create_offer.assert_awaited_once_with(
        amount=None,
        description="StartOS mint",
        label=response.quote,
    )

    checked = await ledger.get_mint_quote_bolt12(response.quote)
    assert checked.amount_paid == 12
    assert checked.amount_issued == 0

    first = await ledger.mint_bolt12(
        outputs=[output(ledger, 8, "bolt12-first")],
        quote_id=response.quote,
    )
    assert sum(promise.amount for promise in first) == 8
    stored = await ledger.crud.get_mint_quote(
        quote_id=response.quote,
        db=ledger.db,
    )
    assert stored is not None
    assert stored.amount_paid == 12
    assert stored.amount_issued == 8
    assert stored.state == MintQuoteState.paid

    second = await ledger.mint_bolt12(
        outputs=[output(ledger, 4, "bolt12-second")],
        quote_id=response.quote,
    )
    assert sum(promise.amount for promise in second) == 4
    stored = await ledger.crud.get_mint_quote(
        quote_id=response.quote,
        db=ledger.db,
    )
    assert stored is not None
    assert stored.amount_paid == 12
    assert stored.amount_issued == 12
    assert stored.state == MintQuoteState.issued


@pytest.mark.asyncio
async def test_bolt12_mint_rejects_outputs_above_unissued_amount(
    ledger: Ledger, monkeypatch: pytest.MonkeyPatch
):
    backend = SimpleNamespace(
        supports_description=True,
        create_offer=AsyncMock(
            return_value=OfferResponse(
                ok=True,
                checking_id="offer-id",
                payment_request="lno1offer",
            )
        ),
        get_offer_status=AsyncMock(
            return_value=OfferStatusResponse(
                amount_paid=Amount(Unit.sat, 8),
            )
        ),
    )
    add_bolt12_backend(ledger, backend)
    monkeypatch.setattr(
        ledger,
        "_verify_mint_quote_witness",
        lambda quote, outputs, signature: True,
    )
    quote = await ledger.mint_quote_bolt12(
        PostMintQuoteBolt12Request(
            unit="sat",
            amount=8,
            pubkey=ledger.pubkey.format().hex(),
        )
    )

    with pytest.raises(
        TransactionError,
        match="amount to mint exceeds paid and unissued amount",
    ):
        await ledger.mint_bolt12(
            outputs=[output(ledger, 16, "bolt12-too-much")],
            quote_id=quote.quote,
        )

    assert await ledger._get_mint_quote_amount_issued(quote.quote) == 0


@pytest.mark.asyncio
async def test_bolt12_melt_quote_uses_fetched_invoice_and_external_settlement(
    ledger: Ledger,
):
    backend = SimpleNamespace(
        get_bolt12_invoice_quote=AsyncMock(
            return_value=Bolt12InvoiceQuoteResponse(
                invoice="lni1invoice",
                payment_hash="ab" * 32,
                amount=Amount(Unit.sat, 21),
                fee=Amount(Unit.sat, 2),
                expiry=1234,
            )
        )
    )
    add_bolt12_backend(ledger, backend)
    request = PostMeltQuoteRequest(unit="sat", request="lno1offer")

    response = await ledger.melt_quote_bolt12(request)
    assert response.method == Method.bolt12.name
    assert response.request == "lno1offer"
    assert response.amount == 21
    assert response.fee_reserve == 2
    assert response.expiry == 1234

    quote = await ledger.crud.get_melt_quote(quote_id=response.quote, db=ledger.db)
    assert quote is not None
    assert quote.checking_id == "lni1invoice"
    assert await ledger.melt_mint_settle_internally(quote, []) == quote
