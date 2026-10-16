---
layout: home

hero:
  name: Udonarium Axe Backend
  text: Axeにつなぐサーバーを、自分の手で置く
  tagline: Udonarium Axeを配信する人が、SkyWay版のトークン発行サーバーか、サーバー版の部屋のサーバーを、自分のアカウントに置くためのドキュメントです。
  image:
    src: /hero.svg
    alt: 参加者のブラウザが、サーバーとつながっている絵
  actions:
    - theme: brand
      text: はじめに
      link: /guide/
    - theme: alt
      text: どれを置くか
      link: /guide/choose
    - theme: alt
      text: 設置の準備
      link: /guide/prepare

features:
  - icon:
      src: /icons/skyway.svg
    title: SkyWay版を置く
    details: 参加者どうしがSkyWayで直接つながる方式です。認証トークンを作るサーバーを、Vercelか、借りているレンタルサーバー（PHP）に置きます。
    link: /skyway/
    linkText: SkyWay版へ
  - icon:
      src: /icons/server.svg
    title: サーバー版を置く
    details: 全員が部屋のサーバーにつながる方式です。卓が残り、裏向きのカードや秘話は見てはいけない人に届かず、GMとPLはDiscordでログインします。CloudflareかVercelに置きます。Axe v1.68.0から使えます。
    link: /server/
    linkText: サーバー版へ
  - icon:
      src: /icons/operate.svg
    title: 公開して運営する
    details: 身内の外にも開くときに、料金の目安、安全のしくみ、預かるもの、申し立てへの応えかた、規約のひな形を確かめます。
    link: /operate/
    linkText: 運営するへ
---

## このドキュメントについて

[Udonarium Axe](https://github.com/Xelltis/udonarium_axe)は、ブラウザだけで遊べるTRPGのオンラインセッション支援ツールです。
Axeを配信するには、参加者どうしをつなぐサーバーが要ります。
このドキュメントでは、そのサーバーの置きかたと、置いたあとの運営のしかたを説明します。

- 初めて置くときは、[はじめに](/guide/)から順に読んでください。
- Axe本体の置きかたは、[Axeの利用ガイド](https://xelltis.github.io/udonarium_axe/)にあります。
