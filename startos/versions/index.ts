import { VersionGraph } from '@start9labs/start-sdk'

import { current } from './current'
import { v0_20_3_2 } from './v0_20_3_2'

export const versionGraph = VersionGraph.of({
  current,
  other: [v0_20_3_2],
})
