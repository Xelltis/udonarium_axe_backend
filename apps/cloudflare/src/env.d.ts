declare namespace Cloudflare {
  interface Env {
    /** The bucket that keeps each room's pictures and sounds, named by the hex SHA-256 of their contents. */
    ASSETS: R2Bucket;
    /** The rate limit that counts uploads for each sender (each /64 for IPv6). */
    UPLOAD_LIMITER: RateLimit;
    /** The rate limit that counts reads from R2 for each sender. */
    READ_LIMITER: RateLimit;
    /** The Origins that rooms, assets and login take requests from, separated by commas. `*` allows all. */
    ACCESS_CONTROL_ALLOW_ORIGIN: string;
    /** One for each room. Its name is the room key (roomKey). */
    ROOMS: DurableObjectNamespace<import('./rooms/room').RoomDurableObject>;
    /** The room list. One for each Worker. */
    LOBBY: DurableObjectNamespace<import('./rooms/lobby').LobbyDurableObject>;
    /** One for each person who logged in. Its name is `discord:<ID>`. */
    ACCOUNTS: DurableObjectNamespace<import('./auth/account').AccountDurableObject>;
    /** The operator's bans and what happened (logins, rooms made, uploads). One for each Worker. */
    MODERATION: DurableObjectNamespace<import('./moderation/store').ModerationDurableObject>;
    /**
     * The Workers Analytics Engine that records what happens in rooms (joins and leaves, why connections
     * closed, writes, dice).
     */
    METRICS: AnalyticsEngineDataset;
    /** The rate limit that counts, for each sender, how often rooms are made and connected to. */
    ROOM_LIMITER: RateLimit;
    /** The rate limit that counts logins and issued tokens for each sender. */
    AUTH_LIMITER: RateLimit;
    /** The Client ID of the Discord app. With all three login settings set, login and rooms work. */
    DISCORD_CLIENT_ID?: string;
    /** The Client Secret of the Discord app (set as a secret). */
    DISCORD_CLIENT_SECRET?: string;
    /** The key that signs tokens. A random string of 32 characters or more (set as a secret). */
    SESSION_SECRET?: string;
    /**
     * The Discord user ids of those who may open the operator's dashboard (/admin), separated by
     * commas. Without it, there is no dashboard.
     */
    ADMIN_DISCORD_IDS?: string;
    /** Those of them who may register a passkey without one they have. Set only while needed. */
    ADMIN_PASSKEY_RESET?: string;
    /**
     * The Discord webhook the operator's alerts go to (rate limits exceeded, banned senders coming back,
     * logins to the dashboard and attempts turned away). Without it, there are no alerts.
     */
    ADMIN_WEBHOOK_URL?: string;
    /** The time from the last person leaving until the room is deleted. */
    ROOM_RETENTION_HOURS: string;
    /** The SkyWay app id. With it and SKYWAY_SECRET set, the Worker issues SkyWay tokens. */
    SKYWAY_APP_ID?: string;
    /** The SkyWay app's secret key (set as a secret). */
    SKYWAY_SECRET?: string;
    /** How many lobby channels the SkyWay room list is split across. 3 when unset. */
    SKYWAY_UDONARIUM_LOBBY_SIZE?: string;
    /** How long an issued SkyWay token works, in seconds (60 to 604800). A day when unset. */
    SKYWAY_TOKEN_TTL_SECONDS?: string;
  }
}

type Env = Cloudflare.Env;
