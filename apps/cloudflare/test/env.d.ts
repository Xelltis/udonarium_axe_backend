declare namespace Cloudflare {
  // The type for calling the Worker from tests with `exports.default.fetch`.
  interface GlobalProps {
    mainModule: typeof import('../src/index');
  }
}
