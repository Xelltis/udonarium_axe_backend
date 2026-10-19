import type { Passkey } from './webauthn.js';

/** Where the dashboard keeps the operators' passkeys and what keeps their sessions honest. */
export interface AdminStore {
  /** The passkeys of one operator, oldest first. */
  passkeysOf(discordId: string): Promise<Passkey[]>;
  /** One passkey, by its credential id. Null when there is none. */
  passkey(id: string): Promise<Passkey | null>;
  /** Adds a passkey, or writes over the one with the same id (as when it has been used). */
  putPasskey(passkey: Passkey): Promise<void>;
  /** Removes a passkey. False when there was none. */
  deletePasskey(id: string): Promise<boolean>;
  /** The generation of the operators' sessions. A session from another generation is over. */
  adminEpoch(): Promise<number>;
  /** Raises the generation, which ends every session. Returns the new one. */
  raiseAdminEpoch(): Promise<number>;
  /** Takes a passkey challenge: true the first time, false once taken (it is kept for ms). */
  takeChallenge(challenge: string, ms: number): Promise<boolean>;
}
