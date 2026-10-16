import type { AppConfig } from '../config';
import type { ServerBackend } from '../core/http/backend';

export interface AppEnv {
  Bindings: Env;
  Variables: { config: AppConfig; backend: ServerBackend };
}
