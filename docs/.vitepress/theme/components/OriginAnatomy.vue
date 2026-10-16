<script setup lang="ts">
import { computed } from 'vue';

/** A URL split into the part that is the Origin and the part that is not, with labels under each. */
const props = withDefaults(defineProps<{ url?: string }>(), {
  url: 'https://yourname.github.io/udonarium_axe/',
});

const parts = computed(() => {
  const m = props.url.match(/^(https?:\/\/)([^/]+)(.*)$/);
  return m ? { scheme: m[1], host: m[2], path: m[3] } : { scheme: '', host: props.url, path: '' };
});
</script>

<template>
  <figure class="axe-figure origin-anatomy">
    <div class="url" role="img" :aria-label="`${parts.scheme}${parts.host} がOriginで、${parts.path} は含めない`">
      <span class="seg origin">
        <span class="text">{{ parts.scheme }}{{ parts.host }}</span>
        <span class="label">Origin（書く値）</span>
      </span>
      <span v-if="parts.path" class="seg path">
        <span class="text">{{ parts.path }}</span>
        <span class="label">パス（書かない）</span>
      </span>
    </div>
    <figcaption>アドレスバーのURLのうち、色の付いた部分だけを書きます。末尾の<code>/</code>も書きません</figcaption>
  </figure>
</template>

<style scoped>
.url {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 4px;
  padding: 22px 16px 18px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
  font-family: var(--vp-font-family-mono);
  font-size: 18px;
}

.seg {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.text {
  padding: 6px 10px;
  border-radius: 8px;
  word-break: break-all;
}

.origin .text {
  background: var(--vp-c-brand-soft);
  border: 2px solid var(--vp-c-brand-2);
  color: var(--vp-c-text-1);
  font-weight: 700;
}

.path .text {
  border: 2px dashed var(--vp-c-divider);
  color: var(--vp-c-text-3);
  text-decoration: line-through;
}

.label {
  font-family: var(--vp-font-family-base);
  font-size: 13px;
  font-weight: 700;
}

.origin .label {
  color: var(--vp-c-brand-1);
}

.path .label {
  color: var(--vp-c-text-3);
}

@media (max-width: 520px) {
  .url {
    font-size: 15px;
  }
}
</style>
