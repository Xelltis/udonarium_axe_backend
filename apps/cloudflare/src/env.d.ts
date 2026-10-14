declare namespace Cloudflare {
  interface Env {
    /** SHA-256 の16進表記を名前にして、画像と音声を置くバケット */
    ASSETS: R2Bucket;
    /** アップロードを IP ごとに数えるレート制限 */
    UPLOAD_LIMITER: RateLimit;
    /** PUT を受ける Origin のカンマ区切り。`*` ならすべて */
    ACCESS_CONTROL_ALLOW_ORIGIN: string;
  }
}

type Env = Cloudflare.Env;
