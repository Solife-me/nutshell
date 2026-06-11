import asyncio
from pathlib import Path
from typing import AsyncGenerator, Optional

import httpx
from bolt11 import decode

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
            return PaymentResponse(
                result=PaymentResult.FAILED,
                error_message=str(exc),
            )

        if res.get("reason"):
            return PaymentResponse(
                result=PaymentResult.FAILED,
                checking_id=res.get("paymentHash"),
                error_message=res["reason"],
            )

        fee_sat = res.get("routingFeeSat")
        return PaymentResponse(
            result=PaymentResult.SETTLED,
            checking_id=res.get("paymentHash"),
            fee=Amount(Unit.sat, int(fee_sat)) if fee_sat is not None else None,
            preimage=res.get("paymentPreimage"),
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
            return PaymentStatus(
                result=PaymentResult.SETTLED,
                fee=Amount(Unit.msat, int(data.get("fees", 0))),
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
                fee=Amount(Unit.msat, int(data.get("fees", 0))),
                preimage=data.get("preimage"),
            )
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
        fees_msat = fee_reserve(amount_msat)
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
