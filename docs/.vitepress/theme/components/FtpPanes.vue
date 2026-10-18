<script setup lang="ts">
/**
 * The two sides of an FTP program such as FileZilla, drawn as a sketch: what to select on the
 * left and where to drop it on the right. It is not a picture of the real window.
 */
const files = ['.env', '.env.example', '.htaccess', 'index.php', 'src/', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md'];
</script>

<template>
  <figure class="axe-figure ftp-panes">
    <div class="window" role="img" aria-label="左のあなたのパソコンで、展開したフォルダの中身をすべて選び、右のサーバーの公開フォルダの中へドラッグする図">
      <div class="pane">
        <div class="bar">ローカル サイト（あなたのパソコン）</div>
        <div class="path">…/udonarium-axe-backend-&lt;版&gt;/</div>
        <ul class="list">
          <li v-for="f in files" :key="f" class="selected">{{ f }}</li>
        </ul>
        <div class="hint">中身をすべて選ぶ（Ctrl＋A / command＋A）</div>
      </div>
      <div class="drag" aria-hidden="true">
        <span>ドラッグ</span>
      </div>
      <div class="pane remote">
        <div class="bar">リモート サイト（レンタルサーバー）</div>
        <div class="path">/public_html/backend/</div>
        <ul class="list">
          <li v-for="f in files" :key="f" class="arrived">{{ f }}</li>
        </ul>
        <div class="hint">ここに、同じ並びで上がっていれば成功</div>
      </div>
    </div>
    <figcaption>FileZillaなどのFTPのソフトの画面の、左右の分かれかた（実際の画面ではなく、配置のイメージです）</figcaption>
  </figure>
</template>

<style scoped>
.window {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: stretch;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
}

.pane {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg);
}

.bar {
  padding: 8px 12px;
  background: var(--vp-c-default-soft);
  font-size: 13px;
  font-weight: 700;
}

.path {
  padding: 6px 12px;
  border-bottom: 1px solid var(--vp-c-divider);
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
  color: var(--vp-c-text-2);
}

.list {
  flex: 1;
  margin: 0 !important;
  padding: 6px 0 !important;
  list-style: none;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
}

.list li {
  margin: 0 !important;
  padding: 2px 12px;
  line-height: 1.6 !important;
}

.list li.selected {
  background: var(--vp-c-brand-soft);
}

.remote .list li.arrived {
  color: var(--vp-c-text-1);
}

.hint {
  padding: 8px 12px;
  border-top: 1px solid var(--vp-c-divider);
  font-size: 12.5px;
  font-weight: 700;
  color: var(--vp-c-brand-1);
}

.drag {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--vp-c-brand-1);
}

.drag::after {
  content: '→';
  font-size: 30px;
  line-height: 1;
  color: var(--vp-c-brand-3);
}

@media (max-width: 640px) {
  .window {
    grid-template-columns: 1fr;
  }

  .drag::after {
    content: '↓';
  }
}
</style>
