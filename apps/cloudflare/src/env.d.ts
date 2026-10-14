declare namespace Cloudflare {
  interface Env {
    /** SHA-256 の16進表記を名前にして、画像と音声を置くバケット */
    ASSETS: R2Bucket;
    /** アップロードを送信元（IPv6 は /64）ごとに数えるレート制限 */
    UPLOAD_LIMITER: RateLimit;
    /** R2 から読む回数を送信元ごとに数えるレート制限 */
    READ_LIMITER: RateLimit;
    /** PUT を受ける Origin のカンマ区切り。`*` ならすべて */
    ACCESS_CONTROL_ALLOW_ORIGIN: string;
    /** 置いたものを残す日数。過ぎたものは 404 にし、アップロードのついでにバケットから消す */
    ASSET_RETENTION_DAYS: string;
  }
}

type Env = Cloudflare.Env;
