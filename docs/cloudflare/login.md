# ログインと役割

Cloudflare版の部屋のサーバーでは、GMとPLは**Discordでログイン**して入ります。
ログインしていない人は、**見学**として入ります。
役割（GM・PL・見学）はサーバーが決め、サーバーが守ります。

## ログインを使えるようにする

ログインには、Discordのアプリ（OAuth2のクライアント）が1つ要ります。
Workerを置く人が、1回だけ作ります。

1. [Discord Developer Portal](https://discord.com/developers/applications)で**New Application**を押し、名前を付けて作ります。名前は、ログインの同意の画面に出ます。
2. **OAuth2**の画面を開きます。
3. **Redirects**に、次のURLを足します。`<Workerのドメイン>`は、デプロイしたWorkerのURLです。
   ```text
   https://<Workerのドメイン>/v1/login/discord/callback
   ```
4. **Client ID**と**Client Secret**（**Reset Secret**で出す）を控えます。
5. Workerに、次の3つをシークレットとして入れます。

| 名前                    | 入れるもの                                                              |
| ----------------------- | ----------------------------------------------------------------------- |
| `DISCORD_CLIENT_ID`     | Discordのアプリの**Client ID**                                          |
| `DISCORD_CLIENT_SECRET` | Discordのアプリの**Client Secret**                                      |
| `SESSION_SECRET`        | トークンに署名する鍵。32文字以上の乱数（`openssl rand -base64 48`など） |

3つは、そろえて入れるか、どれも入れないかのどちらかにします。
一部だけ入れると、すべてのリクエストが`500 config-invalid`になります。
入れ方は[デプロイする](/cloudflare/deploy)と[mainからの自動デプロイ](/cloudflare/auto-deploy)にあります。

::: tip ログインを入れないとき
3つとも入れなければ、ログインと部屋は使えず、アセットサーバーだけが動きます。
SkyWay版の配信に画像と音声の置き場だけを足したいときは、これで構いません。
:::

::: warning SESSION_SECRETを替えると
`SESSION_SECRET`を替えると、出したアクセストークンと招待は、すぐにすべて使えなくなります。
リフレッシュトークンは`SESSION_SECRET`とは別に置いているので使えます。Axeが新しいアクセストークンに替えれば、ログインし直さずに済みます。
招待は作り直してください。
:::

## ログインの流れ

Axeは、ログインのために次のことをします。

```text
Axe                         Worker                          Discord
 │ code_verifier を作る
 │ ── ページを開く ──────────▶ GET /v1/login/discord
 │                             │ ── 同意の画面へ ───────────▶
 │                             │ ◀── 戻る（コード）──────────
 │                             │ GET /v1/login/discord/callback
 │                             │ （Discordで、その人のIDと名前を1度だけ読む）
 │ ◀── 戻り先#login_code=… ──
 │ POST /v1/auth/token（コード＋code_verifier）
 │ ◀── アクセストークンとリフレッシュトークン
```

1. Axeは乱数の`code_verifier`を作って手元に置き、そのSHA-256（`code_challenge`）と戻り先のURLを付けて、`/v1/login/discord`をページとして開きます。
2. Workerは、Discordの同意の画面へ送ります。求めるのは`identify`（その人のIDと名前とアバター）だけで、メールアドレスや参加しているサーバーは求めません。
3. Discordから戻ってくると、WorkerはDiscordでその人の情報を1度だけ読み、使い捨てのコードを付けて、Axeの戻り先へ返します（`#login_code=…`）。
4. Axeは、そのコードと`code_verifier`を`POST /v1/auth/token`に送り、トークンの組を受け取ります。

コードはURLのフラグメント（`#`のあと）に付くので、サーバーのログやほかのサイトへの`Referer`には残りません。
コードを横取りされても、`code_verifier`を持っていないと使えません（PKCE）。
DiscordのアクセストークンはWorkerのどこにも置かず、その人の情報を読んだらそれきりです。

### 戻り先

戻り先は、`ACCESS_CONTROL_ALLOW_ORIGIN`に**名前で書いた**Originのページだけです。
`*`と書いていても、ログインの戻り先には数えません。
どこにでも戻せると、ほかのサイトがログインのコードを受け取れてしまうためです。

### 失敗したとき

戻り先のフラグメントに、`login_error`が付きます。

| `login_error`     | 起きるとき                              |
| ----------------- | --------------------------------------- |
| `denied`          | Discordの同意の画面で断った             |
| `provider-failed` | Discordとのやりとりに失敗した           |
| `rate-limited`    | 送信元からのログインが1分に60回を超えた |

## トークン

| もの                 | 使えるあいだ | 使いかた                                                              |
| -------------------- | ------------ | --------------------------------------------------------------------- |
| アクセストークン     | 15分         | 部屋の`hello`と、`Authorization: Bearer`                              |
| リフレッシュトークン | 30日         | アクセストークンが切れる前に、`POST /v1/auth/token`で新しい組に替える |
| ログインのコード     | 5分          | 1度だけ。`POST /v1/auth/token`でトークンの組に替える                  |

- リフレッシュトークンは、使うたびに新しいものに替わり、使ったものはもう使えません。
- 使ったリフレッシュトークンがまた来たら、盗まれたとみなし、その系統のトークンをすべて無効にします。持ち主もログインし直すことになります。
- アクセストークンは、Workerが署名したJWT（HS256）です。Workerのどこにも置かず、署名と期限で確かめます。

## API

どれも、`ACCESS_CONTROL_ALLOW_ORIGIN`に書いたOriginのページからしか受けません。

| メソッド | パス                         | 内容                                                                              |
| -------- | ---------------------------- | --------------------------------------------------------------------------------- |
| `GET`    | `/v1/auth/config`            | ログインに使える提供元（`{"providers":["discord"]}`）。空ならログインも部屋も無い |
| `GET`    | `/v1/login/discord`          | ログインを始める（ページとして開く。`redirect_uri`と`code_challenge`）            |
| `GET`    | `/v1/login/discord/callback` | Discordから戻ってくる（Discordのアプリに登録するURL）                             |
| `POST`   | `/v1/auth/token`             | コードかリフレッシュトークンを、トークンの組に替える                              |
| `POST`   | `/v1/auth/logout`            | ログアウト。そのリフレッシュトークンの系統を無効にする                            |
| `GET`    | `/v1/account`                | ログインしている人（`Authorization: Bearer`）                                     |
| `DELETE` | `/v1/account`                | アカウントを消す（`Authorization: Bearer`）                                       |

### `POST /v1/auth/token`

```json
{ "grant_type": "login_code", "code": "…", "code_verifier": "…" }
```

```json
{ "grant_type": "refresh_token", "refresh_token": "…" }
```

どちらも、うまくいけば次を返します。

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.…",
  "expiresIn": 900,
  "refreshToken": "…",
  "account": {
    "userId": "8c5b7f0e-2c1d-4e3f-9a8b-7c6d5e4f3a2b",
    "name": "Kai",
    "avatarUrl": "https://cdn.discordapp.com/avatars/…"
  }
}
```

`account.userId`は、同じDiscordのアカウントならいつも同じです。
部屋の`hello`の`userId`にはこれを使います。
手札やインベントリが、端末やタブをまたいでも同じ人のものになります。

| 状態  | コード              | 起きるとき                                               |
| ----- | ------------------- | -------------------------------------------------------- |
| `400` | `invalid-request`   | 本文の形が違う                                           |
| `400` | `invalid-grant`     | コードかリフレッシュトークンが、無効・使用済み・期限切れ |
| `429` | `rate-limited`      | 送信元から1分に60回を超えた                              |
| `503` | `login-unavailable` | ログインが置かれていない                                 |

### アカウントを消す

`DELETE /v1/account`で、その人の情報（Discordの名前とアバターのURL）と、すべてのトークンを消します。
すでに出したアクセストークンは、切れるまでの最大15分は使えます。
部屋の席の表には、消したアカウントの`userId`だけが残り、部屋が消えるときに一緒に消えます。

## 役割

| 役割    | なる人                                                     | できること                                                       |
| ------- | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| `gm`    | 部屋を作った人。GMが`gm`にした人。GMの招待で初めて入った人 | すべて。役割を変える、招待を作る                                 |
| `pl`    | ログインして入った人（招待やGMが変えたときを除く）         | 卓のものを書く                                                   |
| `guest` | ログインせずに入った人。GMが`guest`にした人                | 見るだけ。自分のカーソルと、見学者も話せるタブへの発言だけ書ける |

- 役割は、部屋ごと・ログインした人ごとに、サーバーが覚えます。抜けて入り直しても、同じ役割です。
- 自分の`PeerCursor`の`role`を書き換えても、サーバーが元に戻します。
- 見学者が書けるものの細かい決まりは、[部屋のプロトコル](/cloudflare/protocol#見学者が書けるもの)にあります。

### 役割を変える

GMは、部屋にいる人の役割を変えられます。
Axeは、サーバー（`@authority`）に`ROLE_REQUEST`を送ります。

```json
{ "eventName": "ROLE_REQUEST", "data": { "peerId": "Zz9Yy8XyZq9W8e7r6-", "role": "gm" } }
```

変えたら、その人の`PeerCursor`の役割を書き換えて版を上げ、全員に配ります。
断るときは、頼んだ人に`ROLE_REJECTED`を返します。

| `reason`           | 起きるとき                       |
| ------------------ | -------------------------------- |
| `not-game-master`  | 頼んだ人がGMでない               |
| `unknown-peer`     | その人が部屋にいない             |
| `not-logged-in`    | ログインしていない人は見学のまま |
| `last-game-master` | 部屋のGMがいなくなる             |

### 招待

GMは、役割の付いた招待を作れます。
Axeは`{"type":"invite","role":"pl"}`を送り、返ってきた`invite`を招待リンクに載せます。

- 招待は、作ってから30日使えます。
- 招待で決まるのは、ログインした人がその部屋に**初めて**入るときの役割です。前に入ったことのある人は、今の役割のままです。
- ログインしていない人は、招待があっても見学です。
- ほかの部屋の招待は使えません。

## アップロード

ログインを置いたWorkerでは、画像と音声を置ける（`PUT /v1/assets/:sha256`）のも、ログインした人だけです。
`Authorization: Bearer <アクセストークン>`を付けます。
無ければ`401 login-required`を返します。

## 次に読むもの

- [部屋のプロトコル](/cloudflare/protocol)
- [安全のしくみ](/cloudflare/security#ログイン)
- [運営する人へ](/cloudflare/policies)
