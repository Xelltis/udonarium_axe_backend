## [1.0.2](https://github.com/Xelltis/udonarium_axe_backend/compare/v1.0.1...v1.0.2) (2026-08-11)


### Bug Fixes

* **security:** block web access to stubs/ and correct stub docs ([4124961](https://github.com/Xelltis/udonarium_axe_backend/commit/4124961ee7afa2fded416cf689dcfc336cb10099))

## [1.0.1](https://github.com/Xelltis/udonarium_axe_backend/compare/v1.0.0...v1.0.1) (2026-08-06)


### Bug Fixes

* **security:** block web access to dot-directories such as .git ([1235bfc](https://github.com/Xelltis/udonarium_axe_backend/commit/1235bfca5cd6d3e64163c28ce08d5c6f05adc42b))
* **security:** reject SkyWay scope wildcards in channelName/peerId ([b5c27b2](https://github.com/Xelltis/udonarium_axe_backend/commit/b5c27b23a53b42247e2bfb029fc97e8c380746f8))

# [1.0.0](https://github.com/Xelltis/udonarium_axe_backend/compare/v0.3.0...v1.0.0) (2026-04-19)


* refactor!: restructure src/ into layered architecture with Hono-like router ([ed60640](https://github.com/Xelltis/udonarium_axe_backend/commit/ed606402aa3f5951345def284142413b70086c8a))


### Features

* add .htaccess security hardening for sensitive directories ([d11ca13](https://github.com/Xelltis/udonarium_axe_backend/commit/d11ca13cd2667cc281f14029e3a1b06e2ed7aafd))


### BREAKING CHANGES

* src/ directory structure reorganized into
subdirectories. All require_once paths have changed.

# [0.3.0](https://github.com/Xelltis/udonarium_axe_backend/compare/v0.2.1...v0.3.0) (2026-04-18)


### Bug Fixes

* **AppConfig:** improve error handling for .env file parsing ([d543c04](https://github.com/Xelltis/udonarium_axe_backend/commit/d543c045f0820322149bcf6b06db879478887f4a))


### Features

* add permission script for Sakura rental server ([17543e1](https://github.com/Xelltis/udonarium_axe_backend/commit/17543e190bd2c3073336316aa1b11918eb74148e))
* **AppConfig:** strengthen validation and error messages ([53146ad](https://github.com/Xelltis/udonarium_axe_backend/commit/53146adddba2530abf095580f6e8e0a585a5e837))
* prioritize same-directory .env for FTP deployment ([74d37d5](https://github.com/Xelltis/udonarium_axe_backend/commit/74d37d56b4e896e071dbd75fb050b1da6c4b5ed1))
* **Response:** add Cache-Control no-store header ([f213629](https://github.com/Xelltis/udonarium_axe_backend/commit/f213629e90c5398b9dde72756658d07616aa3a4a))
* **SkywayAuth:** use nullable params and named constant ([8729a8b](https://github.com/Xelltis/udonarium_axe_backend/commit/8729a8bb0e8541d93eccd4878384a91242ea0c44))

## [0.2.1](https://github.com/Xelltis/udonarium_axe_backend/compare/v0.2.0...v0.2.1) (2026-04-18)


### Bug Fixes

* correct php-cs-fixer config path in VS Code settings ([075e388](https://github.com/Xelltis/udonarium_axe_backend/commit/075e3884c0580b2037d2f7784f8a3e543ea893bf))
* unify Docker image name across compose and tooling ([e236ae1](https://github.com/Xelltis/udonarium_axe_backend/commit/e236ae1b1d97ccbc197ae572bfe6e9e0ec81d24f))

# [0.2.0](https://github.com/Xelltis/udonarium_axe_backend/compare/v0.1.0...v0.2.0) (2026-04-18)


### Features

* add comprehensive PHPDoc to all source classes ([a43dedd](https://github.com/Xelltis/udonarium_axe_backend/commit/a43deddbc164598c209f35b6ae82922764f772ba))
