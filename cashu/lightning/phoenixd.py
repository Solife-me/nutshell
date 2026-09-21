import asyncio
from pathlib import Path
from typing import Any, AsyncGenerator, Optional

import httpx
from bolt11 import decode
from loguru import logger

from ..core.base import Amount, MeltQuote, Unit
from ..core.helpers import fee_reserve
from ..core.models import PostMeltQuoteRequest
from ..core.settings import settings
from .base import (
    InvoiceResponse,
    LightningBackend,
    PaymentQuoteResponse,
    PaymentResponse,
    PaymentResult,
    PaymentStatus,
    StatusResponse,
)


class PhoenixdWallet(LightningBackend):
    """https://phoenix.acinq.co/server/"""

    supported_units = {Unit.sat}
    unit = Unit.sat
    supports_description: bool = True

    def __init__(self, unit: Unit = Unit.sat, **kwargs):
        self.assert_unit_supported(unit)
        self.unit = unit

        endpoint = settings.mint_phoenixd_endpoint
        password = self._load_password(settings.mint_phoenixd_password)

        if not endpoint:
            raise Exception("cannot initialize PhoenixdWallet: no endpoint")
        if not password:
            raise Exception("cannot initialize PhoenixdWallet: no password")

        self.endpoint = endpoint[:-1] if endpoint.endswith("/") else endpoint
        self.client = httpx.AsyncClient(
            base_url=self.endpoint,
            auth=("nutshell", password),
            timeout=None,
        )

    def _load_password(self, password_or_path: Optional[str]) -> Optional[str]:
        if not password_or_path:
            return None

        path = Path(password_or_path)
        if not path.exists():
            return password_or_path

        content = path.read_text().strip()
        for line in content.splitlines():
            key, _, value = line.partition("=")
            if key.strip() == "http-password":
                return value.strip().strip('"')
        return content

    @staticmethod
    def _parse_amount(value: Any, unit: Unit) -> Optional[Amount]:
        """Parse a numeric field from phoenixd into an Amount, or None."""
        if value is None:
            return None
        try:
            return Amount(unit, int(value))
        except (TypeError, ValueError):
            logger.warning(f"phoenixd returned an unparsable amount: {value!r}")
            return None

    async def status(self) -> StatusResponse:
        try:
            r = await self.client.get("/getbalance", timeout=15)
            r.raise_for_status()
            data = r.json()
        except Exception as exc:
            return StatusResponse(
                error_message=f"Failed to connect to {self.endpoint} due to: {exc}",
                balance=Amount(self.unit, 0),
            )

        return StatusResponse(
            error_message=None,
            balance=Amount(Unit.sat, int(data.get("balanceSat", 0))),
        )

    async def create_invoice(
        self,
        amount: Amount,
        memo: Optional[str] = None,
        description_hash: Optional[bytes] = None,
        unhashed_description: Optional[bytes] = None,
        **kwargs,
    ) -> InvoiceResponse:
        data: dict[str, str | int] = {
            "amountSat": amount.to(Unit.sat).amount,
        }

        if description_hash:
            data["descriptionHash"] = description_hash.hex()
        elif unhashed_description:
            data["description"] = unhashed_description.decode("utf-8")
        else:
            data["description"] = memo or ""

        if kwargs.get("expiry"):
            data["expirySeconds"] = kwargs["expiry"]

        try:
            r = await self.client.post("/createinvoice", data=data)
            r.raise_for_status()
            res = r.json()
        except httpx.HTTPStatusError:
            return InvoiceResponse(
                ok=False,
                error_message=f"HTTP status: {r.reason_phrase}",
            )
        except Exception as exc:
            return InvoiceResponse(ok=False, error_message=str(exc))

        return InvoiceResponse(
            ok=True,
            checking_id=res["paymentHash"],
            payment_request=res["serialized"],
        )

    async def pay_invoice(
        self, quote: MeltQuote, fee_limit_msat: int
    ) -> PaymentResponse:
        """Pay a bolt11 invoice.

        NOTE: phoenixd's `/payinvoice` accepts only `invoice` and `amountSat`;
        it has no fee-limit parameter, so `fee_limit_msat` cannot be enforced at
        the node. The reserve collected in `get_payment_quote` is sized to cover
        phoenixd's published fee schedule instead, and an overrun is reported
        here so the operator can see the mint absorbing the difference.
        """
        data: dict[str, str | int] = {"invoice": quote.request}

        invoice = decode(quote.request)
        if not invoice.amount_msat:
            data["amountSat"] = Amount(Unit[quote.unit], quote.amount).to(
                Unit.sat, round="up"
            ).amount

        try:
            r = await self.client.post("/payinvoice", data=data, timeout=None)
            r.raise_for_status()
            res = r.json()
        except httpx.HTTPStatusError:
            return PaymentResponse(
                result=PaymentResult.FAILED,
                error_message=f"HTTP status: {r.reason_phrase}",
            )
        except Exception as exc:
            # The request may have failed after phoenixd began the payment, so
            # this is UNKNOWN rather than FAILED: the ledger re-checks the
            # status by payment hash and keeps the proofs pending meanwhile.
            return PaymentResponse(
                result=PaymentResult.UNKNOWN,
                error_message=str(exc),
            )

        if not isinstance(res, dict):
            return PaymentResponse(
                result=PaymentResult.UNKNOWN,
                error_message=f"unexpected /payinvoice response: {res!r}",
            )

        if res.get("reason"):
            return PaymentResponse(
                result=PaymentResult.FAILED,
                checking_id=res.get("paymentHash"),
                error_message=res["reason"],
            )

        # Settle only on positive evidence. phoenixd answers a successful
        # payment with a `payment_sent` object carrying the preimage; treating
        # "no `reason` field" as success would settle any unrecognised response
        # and destroy the user's proofs without paying.
        preimage = res.get("paymentPreimage")
        if not preimage:
            return PaymentResponse(
                result=PaymentResult.UNKNOWN,
                checking_id=res.get("paymentHash"),
                error_message=(
                    "/payinvoice returned no failure reason and no preimage: "
                    f"{res!r}"
                ),
            )

        fee = self._parse_amount(res.get("routingFeeSat"), Unit.sat)
        if fee is not None and fee.to(Unit.msat).amount > fee_limit_msat:
            logger.error(
                f"phoenixd routing fee {fee.to(Unit.msat).amount} msat exceeded "
                f"the melt quote's fee reserve of {fee_limit_msat} msat for "
                f"payment {res.get('paymentHash')}. phoenixd cannot enforce a "
                "fee limit, so the mint absorbs the difference. Consider raising "
                "MINT_PHOENIXD_FEE_PERCENT / MINT_PHOENIXD_FEE_FLAT_SAT."
            )

        return PaymentResponse(
            result=PaymentResult.SETTLED,
            checking_id=res.get("paymentHash"),
            fee=fee,
            preimage=preimage,
        )

    async def get_invoice_status(self, checking_id: str) -> PaymentStatus:
        try:
            r = await self.client.get(f"/payments/incoming/{checking_id}")
            if r.status_code == 404:
                return PaymentStatus(
                    result=PaymentResult.UNKNOWN,
                    error_message=r.text,
                )
            r.raise_for_status()
            data = r.json()
        except Exception as exc:
            return PaymentStatus(result=PaymentResult.UNKNOWN, error_message=str(exc))

        if data.get("isPaid"):
            # phoenixd nets mining and liquidity fees out of incoming payments,
            # so `receivedSat` can be less than the `requestedSat` the mint quote
            # was created for. Crediting the requested amount in that case issues
            # ecash the mint does not hold the sats for, which drains the mint one
            # payment at a time. Only settle once the full amount actually landed.
            requested = self._parse_amount(data.get("requestedSat"), Unit.sat)
            received = self._parse_amount(data.get("receivedSat"), Unit.sat)
            if requested is not None and received is not None:
                shortfall = requested.amount - received.amount
                if shortfall > settings.mint_phoenixd_max_inbound_fee_sat:
                    logger.error(
                        f"phoenixd incoming payment {checking_id} is short by "
                        f"{shortfall} sat (requested {requested.amount}, received "
                        f"{received.amount}). Refusing to credit the mint quote: "
                        "issuing the full amount would leave the mint unbacked. "
                        "Settle with the payer manually, or raise "
                        "MINT_PHOENIXD_MAX_INBOUND_FEE_SAT to absorb the fee."
                    )
                    return PaymentStatus(
                        result=PaymentResult.PENDING,
                        error_message=(
                            f"incoming payment short by {shortfall} sat"
                        ),
                    )
            return PaymentStatus(
                result=PaymentResult.SETTLED,
                fee=self._parse_amount(data.get("fees"), Unit.msat),
                preimage=data.get("preimage"),
            )
        if data.get("isExpired"):
            return PaymentStatus(result=PaymentResult.FAILED)
        return PaymentStatus(result=PaymentResult.PENDING)

    async def get_payment_status(self, checking_id: str) -> PaymentStatus:
        try:
            r = await self.client.get(f"/payments/outgoingbyhash/{checking_id}")
            if r.status_code == 404:
                return PaymentStatus(
                    result=PaymentResult.UNKNOWN,
                    error_message=r.text,
                )
            r.raise_for_status()
            data = r.json()
        except Exception as exc:
            return PaymentStatus(result=PaymentResult.UNKNOWN, error_message=str(exc))

        if data.get("isPaid"):
            return PaymentStatus(
                result=PaymentResult.SETTLED,
                fee=self._parse_amount(data.get("fees"), Unit.msat),
                preimage=data.get("preimage"),
            )
        # phoenixd sets `completedAt` on both success and failure, so an
        # unpaid payment without it is still in flight.
        if data.get("completedAt") is None:
            return PaymentStatus(result=PaymentResult.PENDING)
        return PaymentStatus(result=PaymentResult.FAILED)

    async def get_payment_quote(
        self,
        melt_quote: PostMeltQuoteRequest,
    ) -> PaymentQuoteResponse:
        invoice_obj = decode(melt_quote.request)
        assert invoice_obj.amount_msat, "invoice has no amount."
        amount_msat = int(invoice_obj.amount_msat)

        # phoenixd cannot be given a fee limit at payment time, so the reserve
        # has to cover its published schedule (0.4% + 4 sat) up front. The
        # generic reserve is 1% with a 2 sat floor, which undercollects below
        # roughly 670 sat where the flat 4 sat dominates; take whichever is
        # larger so the mint is never out of pocket on the fee.
        generic_fee_msat = fee_reserve(amount_msat)
        phoenixd_fee_msat = int(
            amount_msat * settings.mint_phoenixd_fee_percent / 100
        ) + settings.mint_phoenixd_fee_flat_sat * 1000
        fees_msat = max(generic_fee_msat, phoenixd_fee_msat)

        return PaymentQuoteResponse(
            checking_id=invoice_obj.payment_hash,
            fee=Amount(Unit.msat, fees_msat).to(self.unit, round="up"),
            amount=Amount(Unit.msat, amount_msat).to(self.unit, round="up"),
        )

    async def paid_invoices_stream(self) -> AsyncGenerator[str, None]:  # type: ignore
        while True:
            await asyncio.sleep(settings.mint_regular_tasks_interval_seconds)
            if False:
                yield ""
