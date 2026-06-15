# Nutshell on StartOS

Nutshell runs a Cashu mint API on your StartOS server. A Cashu mint receives Lightning payments and issues ecash tokens that wallets can use, transfer, and melt back to Lightning.

## Before Using Real Funds

- Treat this service like hot-wallet infrastructure. The mint can receive and spend Lightning funds through the backend you configure.
- Back up your StartOS server before accepting real value. The mint database and private key are required to recognize and redeem issued tokens.
- Start with small limits and test with a wallet before opening the mint to other users.
- Anyone who can access privileged configuration, backups, or the mint private key can affect the mint. Keep server access restricted.

## Initial Setup

1. Install Nutshell.
2. Open Actions and run Configure Mint Settings. Set the mint name, public URL if needed, contact details, limits, and icon URL.
3. Open Actions and run Configure Lightning Backend.
4. Select a backend:
   - FakeWallet: testing only. Do not use it for real funds.
   - Core Lightning: recommended when CLN is installed on the same StartOS server. This backend supports BOLT11 and BOLT12 in this package.
   - LNbits, LND, or phoenixd: supported for BOLT11 mint and melt operations.
5. Start the service.
6. Open Interfaces and use the Mint API URL with a compatible Cashu wallet.

## Lightning Backends

The service starts with FakeWallet so a fresh install can boot without a Lightning node. Before using real money, configure a real backend and restart the service.

For same-server Core Lightning, make sure CLN is started and synced. Nutshell connects to CLN over the StartOS service network using CLN REST and the configured rune.

If you change the backend after the mint has already issued tokens, test carefully. Existing tokens are tied to this mint's database and key material, while future mint and melt operations depend on the newly selected backend.

## BOLT12 Support

BOLT12 ecash support is enabled only when the Lightning backend is Core Lightning. When CLN is selected, the mint advertises NUT-25 support and exposes BOLT12 mint and melt endpoints.

Other backends remain BOLT11-only. If your wallet does not support BOLT12 Cashu flows yet, use normal BOLT11 mint and melt operations.

## Backups and Recovery

Keep regular StartOS backups. Losing the mint database or private key can make previously issued tokens impossible to redeem. Restoring an old backup can also roll the mint back to an earlier state, so avoid issuing new tokens from multiple restored copies of the same mint.

## Public Access

Only publish the mint URL if you intend other wallets to use it. If the mint is public, set conservative mint and melt limits, publish accurate contact information, and monitor backend liquidity.

## Troubleshooting

- If the API stays not ready, check Logs first. The most common causes are missing backend credentials, an unreachable Lightning backend, or a backend that has not finished starting.
- If Core Lightning is selected and dependency health fails, confirm CLN is installed, started, and reachable on the same StartOS server.
- If BOLT12 requests fail with CLN selected, confirm your CLN version and configuration support offers.
- If payments fail, check backend liquidity, channel state, fee limits, and whether the invoice or offer has expired.
- If receiving tokens fails with `proofs are pending` after an interrupted swap, stop Nutshell and run the Repair Pending Swaps action in inspect mode, then repair mode if stale swap locks are reported.
