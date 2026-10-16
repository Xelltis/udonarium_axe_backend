<script setup lang="ts">
/**
 * Axe and the server each write down the other's address: Axe the server's URL, the server Axe's
 * Origin. The same colour marks an address and the place it is written.
 */
withDefaults(defineProps<{ axe?: string; server?: string }>(), {
  axe: 'https://axe.example.com',
  server: 'https://backend.example.com',
});
</script>

<template>
  <figure class="axe-figure mutual-link">
    <div class="row">
      <div class="side">
        <span class="kicker">Axeの配信先</span>
        <span class="address"><code class="a">{{ axe }}</code></span>
        <div class="setting">
          <span class="where">assets/config.json</span>
          <span class="key">backend.url</span>
          <code class="b">{{ server }}</code>
        </div>
      </div>
      <div class="links" aria-hidden="true">
        <span class="link to-right">サーバーのURLを書く</span>
        <span class="link to-left">AxeのOriginを書く</span>
      </div>
      <div class="side">
        <span class="kicker">サーバー</span>
        <span class="address"><code class="b">{{ server }}</code></span>
        <div class="setting">
          <span class="where">サーバーの設定</span>
          <span class="key">ACCESS_CONTROL_ALLOW_ORIGIN</span>
          <code class="a">{{ axe }}</code>
        </div>
      </div>
    </div>
    <figcaption>おたがいに、相手の住所を書きます。同じ色のところは、同じ値です。片方でも違うと、つながりません</figcaption>
  </figure>
</template>

<style scoped>
.row {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: stretch;
  gap: 14px;
}

.side {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
}

.kicker {
  font-size: 15px;
  font-weight: 700;
}

.address code,
.setting code {
  display: inline-block;
  padding: 3px 8px !important;
  border-radius: 6px;
  font-size: 13.5px !important;
  overflow-wrap: anywhere;
}

/* The two addresses, each in its own colour wherever it is written. */
code.a {
  background: rgb(65 182 230 / 0.16) !important;
  color: #0b6d94 !important;
  box-shadow: inset 0 0 0 1.5px rgb(65 182 230 / 0.7);
}

code.b {
  background: var(--vp-c-brand-soft) !important;
  color: var(--vp-c-brand-1) !important;
  box-shadow: inset 0 0 0 1.5px var(--vp-c-brand-3);
}

.dark code.a {
  color: #7dd3f5 !important;
}

.setting {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--vp-c-bg);
}

.where {
  font-size: 12px;
  font-weight: 700;
  color: var(--vp-c-text-2);
}

.key {
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.links {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 18px;
}

.link {
  display: flex;
  flex-direction: column;
  align-items: center;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

.link::after {
  font-size: 24px;
  line-height: 1;
}

.to-right {
  color: var(--vp-c-brand-1);
}

.to-right::after {
  content: '→';
}

.to-left {
  color: #0b6d94;
}

.dark .to-left {
  color: #7dd3f5;
}

.to-left::after {
  content: '←';
}

@media (max-width: 640px) {
  .row {
    grid-template-columns: 1fr;
  }

  .links {
    flex-direction: row;
    justify-content: center;
    gap: 28px;
  }

  .to-right::after {
    content: '↓';
  }

  .to-left::after {
    content: '↑';
  }
}
</style>
