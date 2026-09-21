import { sdk } from '../sdk'
import { configureLightningBackend } from './configureLightningBackend'
import { configureMintSettings } from './configureMintSettings'
import { reconcileBalance } from './reconcileBalance'
import { repairPendingSwaps } from './repairPendingSwaps'
import { rotateKeyset } from './rotateKeyset'
import { showMintBalance } from './showMintBalance'

export const actions = sdk.Actions.of()
  .addAction(configureLightningBackend)
  .addAction(configureMintSettings)
  .addAction(showMintBalance)
  .addAction(repairPendingSwaps)
  .addAction(rotateKeyset)
  .addAction(reconcileBalance)
