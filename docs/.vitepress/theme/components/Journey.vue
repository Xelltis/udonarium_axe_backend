<script setup lang="ts">
import { computed } from 'vue';
import { withBase } from 'vitepress';

/**
 * Where a setup page sits among the pages a setup goes through, from making the app to telling
 * Axe the URL. The middle step has two pages to choose from; the one being read stands in for
 * both.
 */
const props = defineProps<{ mode: 'skyway' | 'server'; here: string }>();

type Page = { key: string; title: string; link: string };

const ROUTES: Record<'skyway' | 'server', { label: string; steps: Page[][] }> = {
  skyway: {
    label: 'SkyWay版を置く流れ',
    steps: [
      [{ key: 'app', title: 'SkyWayのアプリを作る', link: '/skyway/app' }],
      [
        { key: 'vercel', title: 'Vercelに置く', link: '/skyway/vercel' },
        { key: 'php', title: 'レンタルサーバーに置く', link: '/skyway/php' },
        { key: 'cloudflare', title: 'Cloudflareに置く', link: '/skyway/cloudflare' },
      ],
      [{ key: 'config', title: 'Axeにつなぐ', link: '/guide/client-config' }],
    ],
  },
  server: {
    label: 'サーバー版を置く流れ',
    steps: [
      [{ key: 'discord', title: 'Discordのアプリを作る', link: '/server/discord' }],
      [
        { key: 'cloudflare', title: 'Cloudflareに置く', link: '/server/cloudflare' },
        { key: 'vercel', title: 'Vercelに置く', link: '/server/vercel' },
      ],
      [{ key: 'config', title: 'Axeにつなぐ', link: '/guide/client-config' }],
    ],
  },
};

const route = computed(() => ROUTES[props.mode]);
const current = computed(() => route.value.steps.findIndex((pages) => pages.some((p) => p.key === props.here)));
const shown = computed(() =>
  route.value.steps.map((pages, i) => {
    const here = pages.find((p) => p.key === props.here);
    return { pages: here ? [here] : pages, state: i < current.value ? 'done' : i === current.value ? 'here' : 'next' };
  }),
);
</script>

<template>
  <nav class="axe-journey" :aria-label="route.label">
    <span class="label">{{ route.label }}</span>
    <ol>
      <li v-for="(step, i) in shown" :key="i" :class="step.state" :aria-current="step.state === 'here' ? 'step' : undefined">
        <span class="num">{{ i + 1 }}</span>
        <span class="pages" :class="{ choice: step.pages.length > 1 }">
          <template v-for="(p, j) in step.pages" :key="p.key">
            <span v-if="j > 0" class="or">または</span>
            <span v-if="step.state === 'here'" class="title">{{ p.title }}</span>
            <a v-else class="title" :href="withBase(p.link)">{{ p.title }}</a>
          </template>
        </span>
        <span v-if="step.state === 'here'" class="badge">このページ</span>
      </li>
    </ol>
  </nav>
</template>

<style scoped>
.axe-journey {
  margin: 28px 0 8px;
  padding: 14px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
  word-break: auto-phrase;
}

.label {
  display: block;
  margin-bottom: 10px;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--vp-c-text-2);
}

ol {
  display: flex;
  align-items: stretch;
  gap: 22px;
  margin: 0 !important;
  padding: 0 !important;
  list-style: none;
}

li {
  position: relative;
  flex: 1 1 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  margin: 0 !important;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--vp-c-bg);
  line-height: 1.5 !important;
}

/* The arrow to the next step. */
li + li::before {
  content: '';
  position: absolute;
  top: 50%;
  left: -17px;
  width: 10px;
  height: 10px;
  border-top: 2px solid var(--vp-c-text-3);
  border-right: 2px solid var(--vp-c-text-3);
  transform: translateY(-50%) rotate(45deg);
}

.num {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid var(--vp-c-divider);
  font-size: 12.5px;
  font-weight: 700;
  color: var(--vp-c-text-2);
}

.pages {
  flex: 1 1 8em;
  font-size: 14px;
  font-weight: 600;
}

.title {
  color: var(--vp-c-text-1);
}

a.title {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
  text-decoration-color: var(--vp-c-brand-soft);
  text-underline-offset: 3px;
}

a.title:hover {
  text-decoration-color: var(--vp-c-brand-1);
}

/* Two pages to choose from, one above the other. */
.pages.choice {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}

.or {
  font-size: 11.5px;
  font-weight: 400;
  color: var(--vp-c-text-2);
}

.done .num {
  border-color: var(--vp-c-brand-3);
  color: var(--vp-c-brand-1);
}

.here {
  outline: 2px solid var(--vp-c-brand-2);
  background: var(--vp-c-brand-soft);
}

.here .num {
  border-color: var(--axe-c-solid);
  background: var(--axe-c-solid);
  color: var(--vp-c-white);
}

.badge {
  padding: 0 8px;
  border-radius: 6px;
  background: var(--axe-c-solid);
  font-size: 11.5px;
  font-weight: 700;
  color: var(--vp-c-white);
}

@media (max-width: 640px) {
  ol {
    flex-direction: column;
    gap: 16px;
  }

  li + li::before {
    top: -13px;
    left: 22px;
    transform: rotate(135deg);
  }
}
</style>
