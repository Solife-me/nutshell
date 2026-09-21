import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

import { storeJson } from '../fileModels/store.json'

export const current = VersionInfo.of({
  version: '0.20.3:3',
  releaseNotes: {
    en_US: `Security release. Fixes a way for an attacker to take funds from the mint, and turns on the safety mechanisms that catch such a drain.

**Mint loss of funds**

- Fixes a race in melt where polling the public melt-quote endpoint during a payment could release the ecash back to the spender while the Lightning payment was still in flight, so the mint both paid the invoice and handed back the ecash. The executor is now the sole authority over a payment it is running.
- Fixes the phoenixd backend crediting the full mint quote amount when phoenixd had netted its fees out of the incoming payment, issuing ecash the mint held no sats for. Such a quote now stays unpaid and is logged instead; \`MINT_PHOENIXD_MAX_INBOUND_FEE_SAT\` can absorb a shortfall if you prefer.
- Fixes the phoenixd backend treating any unrecognized reply to a payment request as success, which destroyed the spender's ecash without paying the invoice. Settlement now requires a payment preimage.
- Sizes the phoenixd fee reserve to phoenixd's own schedule (0.4% + 4 sat). phoenixd accepts no fee limit at payment time, so the previous reserve left the mint paying the difference on small withdrawals.
- Blocks two melt quotes for the same invoice from being paid at once. Matching only on the backend's payment id missed the case where one invoice yields two quotes with different ids.
- Fixes IP rate limiting honoring an \`X-Forwarded-For\` header from any client, which let a caller pick a fresh rate-limit bucket per request. Forwarded headers are now believed only from a trusted proxy.

**Keyset rotation**

- Adds a **Rotate Keyset** action so a keyset can be retired and replaced from the StartOS UI. Inspect mode lists your keysets and changes nothing. Rotating does not invalidate ecash already issued: the mint keeps honoring those proofs, it only stops issuing new ones.
- Fixes keyset rotation picking the wrong keyset to derive from when a unit had more than one active keyset: the "highest counter" comparison never advanced, so the winner was whichever keyset came last. The same bug decided which derivation path the mint adopted on startup.
- Rotation now retires every active keyset for the unit, and an unspecified fee carries over from the retiring keyset instead of silently resetting to zero.

**Safety mechanisms now on by default**

- The balance watchdog now runs, and shuts the mint down if issued ecash ever exceeds what the Lightning backend can pay out. Use **Ignore Balance Mismatch** in Configure Mint Settings to start a mint whose balances are already mismatched, reconcile them, then turn it back off.
- Melting now stops after the mint cannot determine a payment's outcome, rather than accepting withdrawals it may be unable to resolve. Restart Nutshell to clear it once the backend is healthy.
- IP rate limiting is now enabled, including on existing installs. If wallets see unexpected 429 responses, set **Trusted Proxy IPs** in Configure Mint Settings to the address StartOS proxies from, or turn rate limiting off.

Review your mint balance against your Lightning balance after upgrading. If the watchdog stops the mint on first start, the two are already out of step and need reconciling before it will run.`,
  },
  migrations: {
    up: async ({ effects }) => {
      // Existing installs hold an explicit `mintRateLimit: 'false'`, so the new
      // default alone would not reach them.
      await storeJson.merge(effects, {
        mintForwardedAllowIps: '127.0.0.1',
        mintRateLimit: 'true',
        mintRateLimitProxyTrust: 'true',
        mintWatchdogIgnoreMismatch: 'false',
      })
    },
    // Downgrading would restore the melt race and the phoenixd accounting bugs.
    down: IMPOSSIBLE,
  },
})
