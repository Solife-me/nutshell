import { setupManifest } from '@start9labs/start-sdk'

import {
  alertInstall,
  depClnDescription,
  depLnbitsDescription,
  depLndDescription,
  depPhoenixdDescription,
  long,
  short,
} from './i18n'

export const manifest = setupManifest({
  id: 'nutshell',
  title: 'Nutshell',
  license: 'MIT',
  packageRepo: 'https://github.com/cashubtc/nutshell',
  upstreamRepo: 'https://github.com/cashubtc/nutshell',
  marketingUrl: 'https://cashu.space/',
  donationUrl: null,
  description: { short, long },
  volumes: ['main'],
  images: {
    nutshell: {
      source: {
        dockerBuild: {
          dockerfile: './Dockerfile.startos',
          workdir: '.',
        },
      },
      arch: ['x86_64', 'aarch64'],
    },
  },
  alerts: {
    install: alertInstall,
    update: null,
    uninstall: null,
    restore: null,
    start: null,
    stop: null,
  },
  dependencies: {
    lnbits: {
      description: depLnbitsDescription,
      optional: true,
      metadata: {
        title: 'LNbits',
        icon: 'https://raw.githubusercontent.com/Start9Labs/lnbits-startos/refs/heads/master/icon.svg',
      },
    },
    lnd: {
      description: depLndDescription,
      optional: true,
      metadata: {
        title: 'LND',
        icon: 'https://raw.githubusercontent.com/Start9Labs/lnd-startos/refs/heads/master/icon.svg',
      },
    },
    phoenixd: {
      description: depPhoenixdDescription,
      optional: true,
      metadata: {
        title: 'phoenixd',
        icon: 'https://raw.githubusercontent.com/Start9-Community/phoenixd-startos/refs/heads/master/icon.svg',
      },
    },
    'c-lightning': {
      description: depClnDescription,
      optional: true,
      metadata: {
        title: 'Core Lightning',
        icon: 'https://raw.githubusercontent.com/Start9Labs/cln-startos/refs/heads/master/icon.svg',
      },
    },
  },
})
