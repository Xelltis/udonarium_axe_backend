<script setup lang="ts">
import { withBase } from 'vitepress';

/** The three questions of the choosing page, drawn as a tree that ends in a page to follow. */
const branches = [
  {
    answer: 'いいえ・分からない',
    mode: 'SkyWay版',
    question: 'PHPの動くレンタルサーバーを借りている？',
    results: [
      { answer: 'はい', name: 'PHP版', link: '/skyway/php' },
      { answer: 'いいえ', name: 'Vercel版', sub: 'トークン発行', link: '/skyway/vercel', recommended: true },
    ],
  },
  {
    answer: 'はい',
    mode: 'サーバー版',
    question: 'Vercelにトークン発行とまとめたい？',
    results: [
      { answer: 'はい', name: 'Vercel版', sub: '部屋のサーバー', link: '/server/vercel' },
      { answer: 'いいえ・迷う', name: 'Cloudflare版', link: '/server/cloudflare', recommended: true },
    ],
  },
];
</script>

<template>
  <figure class="axe-figure choose-flow">
    <div class="root">
      <span class="q">はじめの問い</span>
      裏向きのカードや秘話を確実に隠したい？<br />全員が抜けても卓を残したい？
    </div>
    <div class="branches">
      <div v-for="b in branches" :key="b.mode" class="branch">
        <div class="answer">{{ b.answer }}</div>
        <div class="mode">{{ b.mode }}</div>
        <div class="question">{{ b.question }}</div>
        <div class="results">
          <a v-for="r in b.results" :key="r.name" class="result" :class="{ recommended: r.recommended }" :href="withBase(r.link)">
            <span class="answer small">{{ r.answer }}</span>
            <span class="name">{{ r.name }}</span>
            <span v-if="r.sub" class="sub">{{ r.sub }}</span>
            <span v-if="r.recommended" class="badge">迷ったらこれ</span>
            <span class="go">手順へ</span>
          </a>
        </div>
      </div>
    </div>
    <figcaption>答えをたどって、いちばん下の置きかたのページへ進みます</figcaption>
  </figure>
</template>

<style scoped>
.root {
  margin: 0 auto;
  max-width: 560px;
  padding: 16px 20px;
  border-radius: 14px;
  background: var(--axe-c-solid);
  color: var(--vp-c-white);
  font-weight: 700;
  line-height: 1.7;
  text-align: center;
}

.q {
  display: block;
  font-size: 12.5px;
  font-weight: 500;
  opacity: 0.85;
}

.branches {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  margin-top: 28px;
}

/* The two lines down from the first question. */
.branches::before {
  content: '';
  position: absolute;
  top: -28px;
  left: 25%;
  right: 25%;
  height: 14px;
  border: 3px solid var(--vp-c-brand-3);
  border-bottom: 0;
  border-radius: 10px 10px 0 0;
}

.branch {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  background: var(--vp-c-bg-soft);
}

.answer {
  align-self: center;
  padding: 2px 12px;
  border-radius: 999px;
  background: var(--vp-c-default-soft);
  font-size: 13px;
  font-weight: 700;
  color: var(--vp-c-text-1);
}

.answer.small {
  align-self: flex-start;
  font-size: 12px;
}

.mode {
  font-size: 20px;
  font-weight: 700;
  text-align: center;
  color: var(--vp-c-brand-1);
}

.question {
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--vp-c-bg);
  border: 1px dashed var(--vp-c-divider);
  font-size: 14.5px;
  font-weight: 600;
  text-align: center;
}

.results {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.result {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  text-decoration: none !important;
  transition:
    border-color 0.2s,
    transform 0.2s;
}

.result:hover {
  border-color: var(--vp-c-brand-2);
  transform: translateY(-2px);
}

.result.recommended {
  border: 2px solid var(--vp-c-brand-2);
}

.name {
  font-size: 15px;
  font-weight: 700;
  color: var(--vp-c-brand-1);
  line-height: 1.5;
}

.sub {
  margin-top: -4px;
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-c-text-2);
}

/* Pushed to the bottom, so the cards of a row line up whatever is above. */
.go {
  margin-top: auto;
  padding-top: 4px;
  font-size: 13px;
  font-weight: 700;
  color: var(--vp-c-brand-1);
}

.go::after {
  content: ' →';
}

.badge {
  align-self: flex-start;
  padding: 1px 8px;
  border-radius: 6px;
  background: var(--vp-c-brand-soft);
  font-size: 12px;
  font-weight: 700;
  color: var(--vp-c-brand-1);
}

@media (max-width: 640px) {
  .branches {
    grid-template-columns: 1fr;
  }

  .branches::before {
    display: none;
  }
}
</style>
