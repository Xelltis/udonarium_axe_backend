<script setup lang="ts">
/** The trip a login takes, with the address that has to be registered at Discord singled out. */
withDefaults(defineProps<{ domain?: string }>(), { domain: '<部屋のサーバーのドメイン>' });
</script>

<template>
  <figure class="axe-figure login-flow">
    <ol class="trip">
      <li>
        <span class="who">Axe</span>
        <span class="what">参加者が「Discordでログイン」を押します。</span>
      </li>
      <li>
        <span class="who">部屋のサーバー</span>
        <span class="what">Discordのログインの画面へ送ります。</span>
      </li>
      <li>
        <span class="who">Discord</span>
        <span class="what">参加者が、ログインを許可します。</span>
      </li>
      <li class="key">
        <span class="who">部屋のサーバー</span>
        <span class="what">Discordが、登録された戻り先へ戻してきます。</span>
        <code class="address">https://<wbr />{{ domain }}<wbr />/v1<wbr />/login<wbr />/discord<wbr />/callback</code>
        <span class="note">このURLを、Discordのアプリの「Redirects」に登録します</span>
      </li>
      <li>
        <span class="who">Axe</span>
        <span class="what">ログインした名前が出ます。</span>
      </li>
    </ol>
    <figcaption>Discordは、登録された戻り先にしか戻りません。1文字でも違うと、ログインが止まります</figcaption>
  </figure>
</template>

<style scoped>
.trip {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0 !important;
  padding: 0 !important;
  list-style: none;
  counter-reset: trip;
}

/* The line the steps hang on. */
.trip::before {
  content: '';
  position: absolute;
  top: 20px;
  bottom: 20px;
  left: 17px;
  width: 3px;
  border-radius: 2px;
  background: var(--vp-c-divider);
}

.trip li {
  position: relative;
  display: grid;
  grid-template-columns: 9em 1fr;
  align-items: baseline;
  column-gap: 12px;
  row-gap: 8px;
  margin: 0 !important;
  padding: 10px 14px 10px 52px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  counter-increment: trip;
  line-height: 1.6 !important;
}

.trip li::before {
  content: counter(trip);
  position: absolute;
  top: 50%;
  left: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--vp-c-bg);
  border: 2px solid var(--vp-c-divider);
  transform: translateY(-50%);
  font-size: 13px;
  font-weight: 700;
}

.trip li.key {
  border: 2px solid var(--vp-c-brand-2);
  background: var(--vp-c-brand-soft);
}

.trip li.key::before {
  border-color: var(--axe-c-solid);
  background: var(--axe-c-solid);
  color: var(--vp-c-white);
}

.who {
  font-size: 15px;
  font-weight: 700;
  color: var(--vp-c-brand-1);
}

.what {
  font-size: 14.5px;
  color: var(--vp-c-text-1);
}

.address,
.note {
  grid-column: 1 / -1;
}

.address {
  display: block;
  padding: 8px 12px !important;
  border-radius: 8px;
  font-size: 14px !important;
  word-break: normal;
  overflow-wrap: anywhere;
}

.note {
  font-size: 14px;
  font-weight: 700;
}

@media (max-width: 560px) {
  .trip li {
    grid-template-columns: 1fr;
  }
}
</style>
