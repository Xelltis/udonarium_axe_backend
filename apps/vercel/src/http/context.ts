import type { AppConfig } from '../config/types.js';

export interface AppVariables {
  config: AppConfig;
}

export interface AppEnv {
  Variables: AppVariables;
}
