---
layout: home

hero:
  name: Udonarium Axe Backend
  text: Axeを動かすサーバーを、自分の手で
  tagline: SkyWay版の配信を支えるサーバーと、SkyWayを使わずに遊べるサーバー版（ベータ）を用意しています。
  actions:
    - theme: brand
      text: はじめに
      link: /guide/
    - theme: alt
      text: クイックスタート
      link: /guide/quickstart
    - theme: alt
      text: 今後の計画
      link: /guide/roadmap

features:
  - title: PHP版
    details: SkyWay版の配信で使う認証トークンを発行します。レンタルサーバー（Apache＋PHP 8.3〜）に置き、.envを書くだけで動きます。
    link: /php/
    linkText: PHP版を見る
  - title: Vercel版
    details: 同じトークン発行をVercel Functionsで動かします。Deployボタンを押して環境変数を入れるだけで、サーバーの管理は要りません。
    link: /vercel/
    linkText: Vercel版を見る
  - title: Cloudflare版
    details: サーバー版のWorkerです。画像と音声を置き、参加者はP2Pの代わりにここから受け取ります。部屋ごとのサーバー（Durable Objects）も入っていて、Axe側の対応ができればSkyWayなしで遊べます。
    link: /cloudflare/
    linkText: Cloudflare版を見る
---

## このドキュメントについて

[Udonarium Axe](https://github.com/Xelltis/udonarium_axe)は、ブラウザだけで遊べるTRPGのオンラインセッション支援ツールです。
このリポジトリには、Axeを動かすためのサーバーをまとめて置いています。

Axeの配信には、2つの方式があります。

- **SkyWay版**：参加者どうしがSkyWayを使ってP2Pでつながる、いまの方式です。認証トークンを発行するサーバー（PHP版かVercel版）が1つ要ります。画像と音声の置き場（Cloudflare版）を足すこともできます。
- **サーバー版**：部屋ごとのサーバー（CloudflareのDurable Objects）に参加者がつながる方式で、SkyWayを使いません。サーバー側はでき、Axe側の対応を進めているところです。

どちらの方式で配信するかは、配信ごとに選びます。
SkyWay版は、サーバー版ができたあとも残ります。

- はじめて設置する人は、[はじめに](/guide/)から順に読んでください。
- とにかく早く動かしたい人は、[クイックスタート](/guide/quickstart)へどうぞ。
- サーバー版がどう進むかは、[今後の計画](/guide/roadmap)にあります。
- Axe本体の遊びかたや設置のしかたは、[Axeの利用ガイド](https://xelltis.github.io/udonarium_axe/)にあります。
