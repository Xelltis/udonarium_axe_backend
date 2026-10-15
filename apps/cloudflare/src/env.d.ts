declare namespace Cloudflare {
  interface Env {
    /** 部屋の画像と音声を、部屋ごとに中身の SHA-256 の16進表記を名前にして置くバケット */
    ASSETS: R2Bucket;
    /** アップロードを送信元（IPv6 は /64）ごとに数えるレート制限 */
    UPLOAD_LIMITER: RateLimit;
    /** R2 から読む回数を送信元ごとに数えるレート制限 */
    READ_LIMITER: RateLimit;
    /** 部屋・アセット・ログインを受ける Origin のカンマ区切り。`*` ならすべて */
    ACCESS_CONTROL_ALLOW_ORIGIN: string;
    /** 部屋ごとに1つ。名前は部屋の鍵（roomKey） */
    ROOMS: DurableObjectNamespace<import('./rooms/room').RoomDurableObject>;
    /** 部屋の一覧。Worker ごとに1つ */
    LOBBY: DurableObjectNamespace<import('./rooms/lobby').LobbyDurableObject>;
    /** ログインした人ごとに1つ。名前は `discord:<ID>` */
    ACCOUNTS: DurableObjectNamespace<import('./auth/account').AccountDurableObject>;
    /** 部屋で起きたこと（出入り、閉じた理由、書き込み、ダイス）を書く Workers Analytics Engine */
    METRICS: AnalyticsEngineDataset;
    /** 部屋を作る回数と、部屋につなぐ回数を送信元ごとに数えるレート制限 */
    ROOM_LIMITER: RateLimit;
    /** ログインとトークンの発行を送信元ごとに数えるレート制限 */
    AUTH_LIMITER: RateLimit;
    /** Discord のアプリの Client ID。ログインの3つをそろえて置くと、ログインと部屋が使える */
    DISCORD_CLIENT_ID?: string;
    /** Discord のアプリの Client Secret（シークレットとして置く） */
    DISCORD_CLIENT_SECRET?: string;
    /** トークンに署名する鍵。32文字以上の乱数（シークレットとして置く） */
    SESSION_SECRET?: string;
    /** 最後の1人が出てから部屋を消すまでの時間 */
    ROOM_RETENTION_HOURS: string;
  }
}

type Env = Cloudflare.Env;
