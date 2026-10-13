import type { dynamicEnvValues } from './index.js';

interface ICebEnv {
  readonly CEB_DEV_LOCALE: string;
}

interface ICebCliEnv {
  readonly CLI_CEB_DEV: string;
}

export type EnvType = ICebEnv & ICebCliEnv & typeof dynamicEnvValues;
