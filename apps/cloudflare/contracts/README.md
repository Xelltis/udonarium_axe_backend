# contracts

サーバー版の部屋（`src/rooms`）とUdonarium Axeのあいだのプロトコルです。
このディレクトリはサーバー側が持ち主で、Axeは同じ内容を写して使います。npmには出しません。

| ファイル                 | 中身                                                           |
| ------------------------ | -------------------------------------------------------------- |
| `protocol.ts`            | 封筒の型、定数、エラーのコード、LWWの判定（`judgeUpdate`）     |
| `fixtures/lww.json`      | `judgeUpdate`の期待値。両側のテストが同じものを読む            |
| `fixtures/messages.json` | 封筒の例。サーバーが受け付けるもの・断るもの・送るもの         |
| `fixtures/errors.json`   | 接続を閉じる理由。コードごとに、起きるときとサーバーが送るもの |

`protocol.ts`の`PROTOCOL_VERSION`を上げたら、Axe側の写しも同じ版に揃えます。
版が違うと、サーバーは`hello`を`protocol-mismatch`で断ります。

`apps/cloudflare`の中に置いているのは、Deployボタンがこのディレクトリだけを複製するためです。
外に置くと、複製したリポジトリでビルドできなくなります。
