<script setup lang="ts">
import { computed } from 'vue';

/**
 * What a Deploy button does, from this repository to a running server, and what it makes on the
 * way. One drawing for each of the three button deploys.
 */
const props = defineProps<{ kind: 'vercel-token' | 'vercel-rooms' | 'cloudflare' }>();

const KINDS = {
  'vercel-token': {
    host: 'Vercel',
    dir: 'apps/vercel',
    url: 'https://my-udonarium-backend-vercel.vercel.app',
    made: [
      { name: 'Function', text: 'トークンを作るプログラム。東京のリージョンで動く' },
      { name: '環境変数', text: 'SkyWayのIDとキー、AxeのOrigin' },
    ],
  },
  'vercel-rooms': {
    host: 'Vercel',
    dir: 'apps/vercel',
    url: 'https://my-udonarium-rooms-vercel.vercel.app',
    made: [
      { name: 'Function', text: '部屋のサーバーのプログラム' },
      { name: 'Redis', text: '部屋と一覧とアカウント（あとでつなぐ）' },
      { name: 'Vercel Blob', text: '画像と音声（あとでつなぐ）' },
    ],
  },
  cloudflare: {
    host: 'Cloudflare',
    dir: 'apps/cloudflare',
    url: 'https://udonarium-axe-backend.yourname.workers.dev',
    made: [
      { name: 'Worker', text: '部屋のサーバーのプログラム' },
      { name: 'Durable Objects', text: '部屋ごと、一覧、アカウント' },
      { name: 'R2のバケット', text: '画像と音声（udonarium-axe-backend-assets）' },
    ],
  },
} as const;

const k = computed(() => KINDS[props.kind]);
</script>

<template>
  <figure class="axe-figure deploy-map">
    <div class="row">
      <div class="box">
        <span class="kicker">このリポジトリ</span>
        <span class="name"><code>{{ k.dir }}</code></span>
        <span class="text">プログラムの元。ここは書き換わらない</span>
      </div>
      <div class="arrow"><span>Deployボタン</span></div>
      <div class="box">
        <span class="kicker">あなたのGitHub</span>
        <span class="name">複製されたリポジトリ</span>
        <span class="text">ボタンが作る、あなたのもの。ここが変わると、デプロイし直される</span>
      </div>
      <div class="arrow"><span>自動でデプロイ</span></div>
      <div class="box host">
        <span class="kicker">あなたの{{ k.host }}</span>
        <ul class="made">
          <li v-for="m in k.made" :key="m.name">
            <b>{{ m.name }}</b><span>{{ m.text }}</span>
          </li>
        </ul>
      </div>
    </div>
    <div class="result">
      <span class="kicker">できあがるサーバーのURL</span>
      <code>{{ k.url }}</code>
    </div>
    <figcaption>Deployボタンを押すと、この順に作られます</figcaption>
  </figure>
</template>

<style scoped>
.row {
  display: grid;
  grid-template-columns: 1fr auto 1fr auto 1.4fr;
  align-items: center;
  gap: 10px;
}

.box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  padding: 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
}

.box.host {
  border-color: var(--vp-c-brand-2);
  background: var(--vp-c-brand-soft);
}

.kicker {
  font-size: 12px;
  font-weight: 700;
  color: var(--vp-c-text-2);
}

.name {
  font-size: 15px;
  font-weight: 700;
}

.text {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}

.made {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0 !important;
  padding: 0 !important;
  list-style: none;
}

.made li {
  display: flex;
  flex-direction: column;
  margin: 0 !important;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--vp-c-bg);
  line-height: 1.5 !important;
}

.made b {
  font-size: 14px;
  color: var(--vp-c-brand-1);
}

.made span {
  font-size: 12.5px;
  color: var(--vp-c-text-2);
}

.arrow {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 700;
  color: var(--vp-c-brand-1);
  white-space: nowrap;
}

.arrow::after {
  content: '→';
  font-size: 26px;
  line-height: 1;
  color: var(--vp-c-brand-3);
}

.result {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 14px;
  padding: 12px;
  border-radius: 12px;
  border: 2px dashed var(--vp-c-brand-3);
}

.result code {
  font-size: 14px;
  word-break: normal;
  overflow-wrap: anywhere;
}

@media (max-width: 760px) {
  .row {
    grid-template-columns: 1fr;
  }

  .arrow::after {
    content: '↓';
  }
}
</style>
