import { sdk } from '../sdk'
import { configureLightningBackend } from './configureLightningBackend'
import { configureMintSettings } from './configureMintSettings'

export const actions = sdk.Actions.of()
  .addAction(configureLightningBackend)
  .addAction(configureMintSettings)
