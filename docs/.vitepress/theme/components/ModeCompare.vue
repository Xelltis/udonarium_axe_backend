<script setup lang="ts">
/** Four people around the picture, the same in both drawings. */
const people = [
  { x: 60, y: 60 },
  { x: 260, y: 60 },
  { x: 60, y: 200 },
  { x: 260, y: 200 },
];
/** Every pair of people, for the drawing where each connects to each. */
const pairs = people.flatMap((a, i) => people.slice(i + 1).map((b) => [a, b] as const));
</script>

<template>
  <figure class="axe-figure mode-compare">
    <div class="panels">
      <section class="panel">
        <h4 class="title">SkyWay版</h4>
        <p class="lead">参加者どうしが、1人ずつ直接つながる</p>
        <svg viewBox="0 0 320 270" role="img" aria-labelledby="mc-skyway">
          <title id="mc-skyway">4人の参加者が、それぞれほかの3人と線でつながっている図</title>
          <line v-for="([a, b], i) in pairs" :key="i" :x1="a.x" :y1="a.y" :x2="b.x" :y2="b.y" class="link" />
          <g v-for="(p, i) in people" :key="i" :transform="`translate(${p.x} ${p.y})`">
            <circle r="26" class="node" />
            <circle cy="-7" r="7" class="person" />
            <path d="M -12 13 a 12 10 0 0 1 24 0 z" class="person" />
          </g>
          <rect x="95" y="236" width="130" height="28" rx="14" class="tag" />
          <text x="160" y="255" class="tag-text">SkyWayがつなぐ</text>
        </svg>
        <ul class="points">
          <li>卓の中身は、参加者のブラウザだけが持つ</li>
          <li>置くのは、許可証を渡すだけのサーバー</li>
          <li>全員が抜けると、卓は消える</li>
        </ul>
      </section>
      <section class="panel">
        <h4 class="title">サーバー版</h4>
        <p class="lead">全員が、部屋のサーバー1つにつながる</p>
        <svg viewBox="0 0 320 270" role="img" aria-labelledby="mc-server">
          <title id="mc-server">4人の参加者が、まん中の部屋のサーバーとだけ線でつながっている図</title>
          <line v-for="(p, i) in people" :key="i" :x1="p.x" :y1="p.y" x2="160" y2="130" class="link accent" />
          <rect x="105" y="100" width="110" height="60" rx="14" class="server" />
          <text x="160" y="126" class="server-text">部屋の</text>
          <text x="160" y="146" class="server-text">サーバー</text>
          <g v-for="(p, i) in people" :key="i" :transform="`translate(${p.x} ${p.y})`">
            <circle r="26" class="node" />
            <circle cy="-7" r="7" class="person" />
            <path d="M -12 13 a 12 10 0 0 1 24 0 z" class="person" />
          </g>
          <rect x="70" y="236" width="180" height="28" rx="14" class="tag" />
          <text x="160" y="255" class="tag-text">卓の状態と画像を持つ</text>
        </svg>
        <ul class="points">
          <li>卓の中身は、部屋のサーバーも持つ</li>
          <li>置くのは、卓のすべてを受け持つサーバー</li>
          <li>全員が抜けても、しばらく卓が残る</li>
        </ul>
      </section>
    </div>
  </figure>
</template>

<style scoped>
.panels {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

@media (max-width: 640px) {
  .panels {
    grid-template-columns: 1fr;
  }
}

.panel {
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  padding: 20px 20px 8px;
  background: var(--vp-c-bg-soft);
}

.title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--vp-c-brand-1);
}

.lead {
  margin: 4px 0 8px !important;
  font-size: 14.5px;
  color: var(--vp-c-text-2);
}

svg {
  display: block;
  width: 100%;
  max-width: 360px;
  margin: 0 auto;
}

.link {
  stroke: var(--vp-c-text-3);
  stroke-width: 2.5;
}

.link.accent {
  stroke: var(--vp-c-brand-2);
  stroke-width: 3;
}

.node {
  fill: var(--vp-c-bg);
  stroke: var(--vp-c-divider);
  stroke-width: 2;
}

.person {
  fill: var(--vp-c-text-2);
}

.server {
  fill: var(--axe-c-solid);
}

.server-text {
  fill: var(--vp-c-white);
  font-size: 15px;
  font-weight: 700;
  text-anchor: middle;
}

.tag {
  fill: var(--vp-c-default-soft);
}

.tag-text {
  fill: var(--vp-c-text-1);
  font-size: 13px;
  text-anchor: middle;
}

.points {
  margin: 8px 0 12px !important;
  padding-left: 1.2em !important;
  font-size: 14.5px;
}

.points li {
  line-height: 1.7 !important;
}
</style>
