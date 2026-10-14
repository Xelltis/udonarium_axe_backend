declare namespace Cloudflare {
  // テストから `exports.default.fetch` で Worker を呼ぶときの型
  interface GlobalProps {
    mainModule: typeof import('../src/index');
  }
}
