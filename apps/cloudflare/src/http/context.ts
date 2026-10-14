import type { AppConfig } from '../config';

export interface AppEnv {
  Bindings: Env;
  Variables: { config: AppConfig };
}
