<script setup lang="ts">
import { withBase } from 'vitepress';

/**
 * Steps drawn as cards joined by arrows: across on a wide screen, down on a narrow one. A step
 * with `link` is a link; one with `accent` is drawn in the brand colour, for the step the page is
 * about.
 */
defineProps<{
  steps: { title: string; text?: string; link?: string; accent?: boolean }[];
  caption?: string;
  numbered?: boolean;
}>();
</script>

<template>
  <figure class="axe-figure step-flow">
    <ol class="flow" :class="{ numbered }">
      <li v-for="(step, i) in steps" :key="i" class="step" :class="{ accent: step.accent }">
        <component :is="step.link ? 'a' : 'div'" :href="step.link ? withBase(step.link) : undefined" class="card">
          <span v-if="numbered" class="num">{{ i + 1 }}</span>
          <span class="title">{{ step.title }}</span>
          <span v-if="step.text" class="text">{{ step.text }}</span>
        </component>
      </li>
    </ol>
    <figcaption v-if="caption">{{ caption }}</figcaption>
  </figure>
</template>

<style scoped>
.flow {
  display: flex;
  align-items: stretch;
  gap: 28px;
  margin: 0 !important;
  padding: 0 !important;
  list-style: none;
}

.step {
  position: relative;
  flex: 1 1 0;
  margin: 0 !important;
}

/* The arrow to the next step. */
.step + .step::before {
  content: '';
  position: absolute;
  top: 50%;
  left: -22px;
  width: 16px;
  height: 16px;
  border-top: 3px solid var(--vp-c-brand-3);
  border-right: 3px solid var(--vp-c-brand-3);
  transform: translateY(-50%) rotate(45deg);
}

.card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  padding: 16px 16px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  text-decoration: none !important;
  transition:
    border-color 0.2s,
    transform 0.2s;
}

a.card:hover {
  border-color: var(--vp-c-brand-2);
  transform: translateY(-2px);
}

.accent .card {
  border-color: var(--vp-c-brand-2);
  background: var(--vp-c-brand-soft);
}

.num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--axe-c-solid);
  color: var(--vp-c-white);
  font-size: 14px;
  font-weight: 700;
}

.title {
  font-size: 15.5px;
  font-weight: 700;
  line-height: 1.5;
}

a.card .title {
  color: var(--vp-c-brand-1);
}

.text {
  font-size: 13.5px;
  line-height: 1.65;
  color: var(--vp-c-text-2);
}

@media (max-width: 760px) {
  .flow {
    flex-direction: column;
    gap: 26px;
  }

  .step + .step::before {
    top: -21px;
    left: 50%;
    transform: translateX(-50%) rotate(135deg);
  }
}
</style>
