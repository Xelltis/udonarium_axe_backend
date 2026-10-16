export interface SkywayConfig {
  appId: string;
  secret: string;
  lobbySize: number;
  tokenTtlSeconds: number;
}

export interface CorsPolicy {
  allowedOrigins: string[];
}

export interface AppConfig {
  skyway: SkywayConfig;
  cors: CorsPolicy;
  environment: string | undefined;
}
