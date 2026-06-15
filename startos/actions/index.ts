import { sdk } from '../sdk'
import { configureLightningBackend } from './configureLightningBackend'
import { configureMintSettings } from './configureMintSettings'
import { repairPendingSwaps } from './repairPendingSwaps'
import { showMintBalance } from './showMintBalance'

export const actions = sdk.Actions.of()
  .addAction(configureLightningBackend)
  .addAction(configureMintSettings)
  .addAction(showMintBalance)
  .addAction(repairPendingSwaps)
