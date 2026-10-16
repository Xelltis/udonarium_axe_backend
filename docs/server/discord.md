# Discordのアプリを作る

サーバー版（Cloudflare版と、Vercel版の部屋のサーバー）では、GMとPLがDiscordのアカウントでログインして部屋に入ります。
そのために、サーバーを置く人が、Discordのアプリを1つ作ります。
このページは、その作りかたの手順です。
かかる時間は10分ほどです。

<Journey mode="server" here="discord" />

アプリといっても、プログラムを書くわけではありません。
Discordに「このサーバーからログインを頼む」と登録し、ログインに使う**Client ID**と**Client Secret**を受け取るだけです。
ボット（Bot）は作りません。

::: info Discordの画面の言葉
Discord Developer Portal（アプリを作る画面）は英語で表示されます。
このページでは、ボタンやメニューの名前を画面の表示のまま英語で書きます。
:::

## 0. 用意するもの

- Discordのアカウント（ふだん使っているもので構いません）
- 部屋のサーバーのURL（手順3で使います。まだ決まっていなければ、手順2まで進めて、あとで戻ってきます）

## 1. アプリを作る

1. [Discord Developer Portal](https://discord.com/developers/applications)を開き、Discordのアカウントでログインします。
2. 右上の**New Application**を押します。
3. **Name**に名前を入れます。この名前は、ログインのときにDiscordが出す確認の画面で、ログインする人に見えます。卓や配信の名前にすると分かりやすくなります（例：`Udonarium Axe`）。
4. チーム（team）を選ぶ欄があれば、空のままで構いません。開発者向けの規約（Developer Terms of ServiceとDeveloper Policy）に同意するチェックがあれば入れ、**Create**を押します。
5. 人間かどうかを確かめる画面が出たら、案内に従って答えます。

アプリの画面（**General Information**）が開きます。
アイコンや説明は、入れなくても動きます。

## 2. Client IDとClient Secretを控える

1. 左のメニューの**OAuth2**を開きます。
2. **Client ID**の下の**Copy**を押し、どこかに貼り付けて控えます。
3. **Client Secret**の下の**Reset Secret**を押します。本当に作り直すかを尋ねられたら、**Yes, do it!** を押します。2段階認証を設定しているアカウントでは、確認のコードを求められることがあります。
4. 新しいClient Secretが出るので、**Copy**を押して控えます。

::: warning Client Secretは一度しか出ません
画面を離れると、Client Secretはもう見られません。
控え忘れたときは、もう一度**Reset Secret**を押して作り直します。
作り直すと前のものは使えなくなるので、サーバーに入れた値も入れ替えます。
Client Secretは、ほかの人に見せないでください（→ [設置の準備](/guide/prepare#秘密の値の扱い)）。
:::

控えた2つは、サーバーの設定に入れます。

| サーバーの設定の名前    | 入れるもの    |
| ----------------------- | ------------- |
| `DISCORD_CLIENT_ID`     | Client ID     |
| `DISCORD_CLIENT_SECRET` | Client Secret |

## 3. 戻り先のURLを登録する

Discordでログインしたあと、Discordは決められたURLにだけ戻ります。

<LoginFlow />

その戻り先として、部屋のサーバーのURLを登録します。
部屋のサーバーのURLは、デプロイが終わると決まります。

1. Discord Developer Portalで、作ったアプリを開き、左のメニューの**OAuth2**を開きます。
2. **Redirects**の欄で、URLを入れる欄を足すボタン（**Add Redirect**）を押します。
3. 出てきた欄に、次の形のURLを入れます。

   ```text
   https://<部屋のサーバーのドメイン>/v1/login/discord/callback
   ```

   | 部屋のサーバー              | 入れるURLの例                                                                  |
   | --------------------------- | ------------------------------------------------------------------------------ |
   | Cloudflare版（workers.dev） | `https://udonarium-axe-backend.yourname.workers.dev/v1/login/discord/callback` |
   | Vercel版                    | `https://my-udonarium-rooms-vercel.vercel.app/v1/login/discord/callback`       |
   | カスタムドメイン            | `https://backend.example.com/v1/login/discord/callback`                        |

4. 画面の下に出る**Save Changes**を押します。押さないと、登録されません。

ドメインの部分は、Axeの`config.json`の`backend.url`に書くのと同じにします。
URLは上の形のとおりに書き、末尾に`/`を付けません。
1文字でも違うと、ログインのときにDiscordが`Invalid OAuth2 redirect_uri`を出します。
カスタムドメインを付けたときなど、ドメインを変えたときは、新しいURLを足します。
戻り先は、1つのアプリに複数登録できます。

## ほかの設定について

ログインに使うのは、ここまでの設定だけです。
**Bot**の画面や、**OAuth2**の画面の**OAuth2 URL Generator**は使いません。
**OAuth2**の画面の**Public Client**は、オフのままにします。
部屋のサーバーがDiscordに求めるのは`identify`だけで、ログインした人のユーザーID、名前、アイコンを受け取ります。メールアドレスや、入っているサーバーの一覧は求めません。

## 次に読むもの

- [Cloudflareに置く](/server/cloudflare)
- [Vercelに置く（サーバー版）](/server/vercel)
