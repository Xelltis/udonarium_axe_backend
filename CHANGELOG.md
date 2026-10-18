# [1.1.0](https://github.com/Xelltis/udonarium_axe_backend/compare/v1.0.2...v1.1.0) (2026-10-18)


### Bug Fixes

* **assets:** replace a lone surrogate in an asset name so that it can be served ([a44fe9b](https://github.com/Xelltis/udonarium_axe_backend/commit/a44fe9b208307dbd87450ce952eba5482dd2a90b))
* **cloudflare:** answer HEAD for an asset from the data centre copy, as GET does ([795b73e](https://github.com/Xelltis/udonarium_axe_backend/commit/795b73e05fd2a3e115e77f468349f561bf1a8dc5))
* **cloudflare:** answer HEAD, conditional and range requests through R2 ([b1cbca3](https://github.com/Xelltis/udonarium_axe_backend/commit/b1cbca3ed1303be63c5d6d3f5d08b4b97854127a))
* **cloudflare:** ask the lobby about the rooms of a sweep a hundred at a time ([a8b2a84](https://github.com/Xelltis/udonarium_axe_backend/commit/a8b2a84aad8195874352591d97f94828fcda9f14))
* **cloudflare:** bring the index back in line with what was written after a failed write ([97ff348](https://github.com/Xelltis/udonarium_axe_backend/commit/97ff348a46ef16fed87f5e76d8f0b7549675b097))
* **cloudflare:** clear away the cursors of seats that are gone ([5566aee](https://github.com/Xelltis/udonarium_axe_backend/commit/5566aeefb576f9dc0cd23312aadcaada1f01d2d7))
* **cloudflare:** close back a closing socket and recount a room after a crash ([93cb0f3](https://github.com/Xelltis/udonarium_axe_backend/commit/93cb0f3b467f4730155f27f41f667afd03d66cb0))
* **cloudflare:** close on stray text, and let out a run-out login in a quiet room ([3c0260c](https://github.com/Xelltis/udonarium_axe_backend/commit/3c0260c73cbac6a1cce67fae1c03d8b0dd1c2314))
* **cloudflare:** count IPv6 senders per /64 and leave stored assets uncounted ([c40cd35](https://github.com/Xelltis/udonarium_axe_backend/commit/c40cd35b6df11c5780ddc1b909a68e3a105ded67))
* **cloudflare:** count the rows a flush writes, not the objects it writes ([c136343](https://github.com/Xelltis/udonarium_axe_backend/commit/c136343594878fb75f0f4905970d7ccade62377c))
* **cloudflare:** declare createHash for the typecheck CI runs without @types/node ([d04ab9a](https://github.com/Xelltis/udonarium_axe_backend/commit/d04ab9a7c9f2509f99fdafa881391a174574beb8)), closes [#102](https://github.com/Xelltis/udonarium_axe_backend/issues/102)
* **cloudflare:** finish deleting a room that fails part way ([236b395](https://github.com/Xelltis/udonarium_axe_backend/commit/236b39530e1263226cb91d6bf3e2cf4554d94a22))
* **cloudflare:** give each Worker its own bucket and rate limits ([ffda3bf](https://github.com/Xelltis/udonarium_axe_backend/commit/ffda3bfb724bf4763990017ea42f22e67955bea6))
* **cloudflare:** guard a rolled line's place where Axe keeps it ([6d17b08](https://github.com/Xelltis/udonarium_axe_backend/commit/6d17b08ddc3e8508634d395e54334d462ba1400e))
* **cloudflare:** hand a dropped child back however far its parent, and after a reconnect ([ff5f8f7](https://github.com/Xelltis/udonarium_axe_backend/commit/ff5f8f7aa25cc84fdef9de1da65c57ac18dd2f79))
* **cloudflare:** hand a dropped child back to its writer once its parent comes ([fab6bdc](https://github.com/Xelltis/udonarium_axe_backend/commit/fab6bdcf0e90d6b19c66f4dc6938db9a393a20af))
* **cloudflare:** hand on nothing a client sends in the name of the server ([91d05d4](https://github.com/Xelltis/udonarium_axe_backend/commit/91d05d4021d5b6a7b6c55013cee73cbe3f998936))
* **cloudflare:** hold back a part that arrives before what it belongs to ([f8b2801](https://github.com/Xelltis/udonarium_axe_backend/commit/f8b28011f51aa016790a4e6e25bb647fe345240b))
* **cloudflare:** keep a logged-in seat from guests, and an invite from a turned-away hello ([0c9678a](https://github.com/Xelltis/udonarium_axe_backend/commit/0c9678a2afcfafcaff352d2358dda07286ef9e03))
* **cloudflare:** keep a refused tab's lines from going one by one after it ([24a15f1](https://github.com/Xelltis/udonarium_axe_backend/commit/24a15f1c789c98b4b52fa839ded23230561dac99))
* **cloudflare:** keep a server roll as it was rolled, and say why a roll was not made ([dd2b764](https://github.com/Xelltis/udonarium_axe_backend/commit/dd2b7641e54350ad451c4f3cc573a465a3b2a2d3))
* **cloudflare:** keep a server roll right after its line, and undecorated ([b5cfe3e](https://github.com/Xelltis/udonarium_axe_backend/commit/b5cfe3ec040fca62991ab6be0392e30b9b52804b))
* **cloudflare:** keep a server roll where and when it was rolled ([44437a5](https://github.com/Xelltis/udonarium_axe_backend/commit/44437a58f35456ce2157fd8e01cf604177ae14c3))
* **cloudflare:** keep a token of a deleted account off the account made again ([56a4c0b](https://github.com/Xelltis/udonarium_axe_backend/commit/56a4c0bbbb3fb8e8ed130497b8c3245700349b79))
* **cloudflare:** keep a write from raising an object's version past reach ([0c1674d](https://github.com/Xelltis/udonarium_axe_backend/commit/0c1674d5880acff08929e160d17e09767d4e75b0))
* **cloudflare:** keep cached copies from outliving the bucket's retention ([9e69fa5](https://github.com/Xelltis/udonarium_axe_backend/commit/9e69fa5d171f71ac5b6e649d6b4d69c5bb4506fa))
* **cloudflare:** keep guests from claiming the user id of someone logged in ([8015964](https://github.com/Xelltis/udonarium_axe_backend/commit/8015964281b6f2e18c275b43313a7d36bda6a3d3))
* **cloudflare:** keep seats and uploads to the people they belong to ([80aaf8c](https://github.com/Xelltis/udonarium_axe_backend/commit/80aaf8cb6328fd40ea6bef0c57a9ffdb4c630394))
* **cloudflare:** keep the name of an owned die from those who cannot see its face ([271eb65](https://github.com/Xelltis/udonarium_axe_backend/commit/271eb65ebe96e25a6f968501a8314adf3a51b39b))
* **cloudflare:** keep the room server from being taken over or worn down ([f4cb22f](https://github.com/Xelltis/udonarium_axe_backend/commit/f4cb22fc11e45fe6dfe5bb0fa207d2e060410aa4))
* **cloudflare:** let a GM invite work only while whoever gave it is still GM ([3f268a6](https://github.com/Xelltis/udonarium_axe_backend/commit/3f268a6749d87ba40b0e6a1ab71998704d5e2f9d))
* **cloudflare:** let a masked copy be replaced once its holder may see it ([eacd79b](https://github.com/Xelltis/udonarium_axe_backend/commit/eacd79b647f6a349f2948278cfc9713a9ace0977))
* **cloudflare:** let a seat write and delete only its own cursor ([22c6b3a](https://github.com/Xelltis/udonarium_axe_backend/commit/22c6b3a317e9f926dad24b95025bff464a7f4aa6))
* **cloudflare:** let nobody uncover by a write what the room keeps from them ([3663926](https://github.com/Xelltis/udonarium_axe_backend/commit/3663926808b0e9dc708debf9acbcba3215664675))
* **cloudflare:** let nothing into a room or its assets once it is going ([bdb05a6](https://github.com/Xelltis/udonarium_axe_backend/commit/bdb05a63c1f5130440366d6f290a65638e6d7bba))
* **cloudflare:** let the roller or the GM disclose a server-rolled secret ([b33a224](https://github.com/Xelltis/udonarium_axe_backend/commit/b33a22442c20bac34244ba626cd8e7fdfd5694d5))
* **cloudflare:** let the table's own moves through and keep the rest from uncovering ([8735fb6](https://github.com/Xelltis/udonarium_axe_backend/commit/8735fb6b0c3891c3619ed187eefb712695c4e356))
* **cloudflare:** list the newest rooms and one's own, and limit how often the list is asked for ([8819602](https://github.com/Xelltis/udonarium_axe_backend/commit/8819602c5cd96a9069ea08a1d4957b5285d826af))
* **cloudflare:** look up and spend a refresh token with nothing in between ([d9886c4](https://github.com/Xelltis/udonarium_axe_backend/commit/d9886c475cfe4e8429efad1f717ffaedaa4643c1))
* **cloudflare:** put back the lost change of a seat that holds a masked copy ([ac83643](https://github.com/Xelltis/udonarium_axe_backend/commit/ac8364320a3efa724556dcfd55583598053e8811))
* **cloudflare:** read and write chat and tab fields under attributes ([42e5fa7](https://github.com/Xelltis/udonarium_axe_backend/commit/42e5fa7c39158436c8899b270b4241f025bbaca8))
* **cloudflare:** refuse object versions too large to be moved past ([df7309a](https://github.com/Xelltis/udonarium_axe_backend/commit/df7309a765bad34628becca8c1b22d0006a25c38))
* **cloudflare:** roll nothing into a tab gone meanwhile, nor inherited names ([12df375](https://github.com/Xelltis/udonarium_axe_backend/commit/12df3755c45175b1eedd70e446696d77ee24ebb0))
* **cloudflare:** rotate a refresh token without waiting between the check and the write ([37dd8b6](https://github.com/Xelltis/udonarium_axe_backend/commit/37dd8b66ca6cd90b56de49db52d4f4cd9fecbdec))
* **cloudflare:** set the clock that finishes a deletion before asking the lobby ([340e962](https://github.com/Xelltis/udonarium_axe_backend/commit/340e9620dc51f005e471ac43db36eea7f155731f))
* **cloudflare:** take away an upload that lands after its room was deleted ([335d892](https://github.com/Xelltis/udonarium_axe_backend/commit/335d892e04c31095a616498742f681c75729bdc9))
* **cloudflare:** take no token at all once login is taken away from the Worker ([6213915](https://github.com/Xelltis/udonarium_axe_backend/commit/6213915f362af489c957ae1f975a40a15f295038))
* **cloudflare:** tell a socket why it cannot come in rather than refusing the upgrade ([22dc936](https://github.com/Xelltis/udonarium_axe_backend/commit/22dc9362e9c6f852b3bf684b2d169b24f93bc6cb))
* **cloudflare:** tell formats apart by more than their first two bytes ([8f0a591](https://github.com/Xelltis/udonarium_axe_backend/commit/8f0a59194dd85d0794e82b82fe05574fcf2b6256))
* **cloudflare:** write the count of room writes once a minute ([54e6426](https://github.com/Xelltis/udonarium_axe_backend/commit/54e6426f4248575045ff8432ff759d1b57186e4f))
* **deps:** override nanoid to clear GHSA-2v37-7h3g-55p8 ([a3cfbc5](https://github.com/Xelltis/udonarium_axe_backend/commit/a3cfbc5782cf327f1b60b9f5c2417edb2042c72b))
* **deps:** resolve all 55 open Dependabot security advisories ([7305f23](https://github.com/Xelltis/udonarium_axe_backend/commit/7305f23a418d88ef8c3ab3b75543aa1d9112f86a))
* improve type annotations in CryptoUtils and tsconfig ([fd56b8f](https://github.com/Xelltis/udonarium_axe_backend/commit/fd56b8fd593ff35d0ccf37cd181f5b7ba9d44872))
* make the function bundle load as ESM on the Node.js runtime ([b0995cc](https://github.com/Xelltis/udonarium_axe_backend/commit/b0995cc5ad25d73985742a61882b9ee6e7ed127c))
* **rooms:** answer a request for what is missing or hidden, and mind a deletion told in answer ([0c20112](https://github.com/Xelltis/udonarium_axe_backend/commit/0c20112da25b1d8b2fae49437d4163ffb3634c1f))
* **rooms:** forget who wrote what waited for its parent once the parent comes ([2542056](https://github.com/Xelltis/udonarium_axe_backend/commit/2542056893d1cece7e1d8172062d1eca7a1b2275))
* **rooms:** hand back what a seat made again under a parent that came later, once it comes ([919d7ee](https://github.com/Xelltis/udonarium_axe_backend/commit/919d7eed72209eeed23173a277d6f23c84b166e6))
* **rooms:** hand the one sending a parent what somebody else wrote while it waited for it ([4f6a435](https://github.com/Xelltis/udonarium_axe_backend/commit/4f6a43582ca0d974392ad11b535148105ea8643a))
* **rooms:** keep a returning seat's cursor, dropping the old one only once a new one is written ([a6158fe](https://github.com/Xelltis/udonarium_axe_backend/commit/a6158fe3e47ef4dc83a4bac3811678318e0245af))
* **rooms:** keep the lines of a tab not let go well past a pacing seat's step ([9b6dc7c](https://github.com/Xelltis/udonarium_axe_backend/commit/9b6dc7c3013565011aeb0bd95ad2dd4bdd09dbd3))
* **rooms:** keep the lines of a tab not let go while their deletes keep coming ([4161e59](https://github.com/Xelltis/udonarium_axe_backend/commit/4161e5922957834e10fce65ddd3e40f87c9160e5))
* **rooms:** mind what a seat was told had gone until it makes it again, not for 20 seconds ([acfa9b5](https://github.com/Xelltis/udonarium_axe_backend/commit/acfa9b5a65ffd3ff878ae2e98230a99b84eaf9de))
* **rooms:** mind what was handed back for a while only, and hand back what is made again ([32dcfb7](https://github.com/Xelltis/udonarium_axe_backend/commit/32dcfb76132a79b858ae250bf517890afe742d2a))
* **rooms:** refuse a player making in a deck a card it owns or holds ([51c8dd7](https://github.com/Xelltis/udonarium_axe_backend/commit/51c8dd77d9ac1efdc6742ca6cf5152c33945be30))
* **rooms:** refuse a player making itself the owner of a card that stays in a deck ([b2aece9](https://github.com/Xelltis/udonarium_axe_backend/commit/b2aece9539399dd675f3a47979944a180748f5eb))
* **rooms:** refuse a player putting a card it owns into a deck, not only owning one there ([7ecdac8](https://github.com/Xelltis/udonarium_axe_backend/commit/7ecdac81146bc8e6447097830e20e4b6fd06b386))
* **rooms:** refuse a player seeing a deck's card by hand mark or by a holder it makes late ([29823c0](https://github.com/Xelltis/udonarium_axe_backend/commit/29823c05362a6b2520958b4798990fd25c7df605))
* **rooms:** stay awake while lines are kept from deleting, and let them go after ([bf0ace1](https://github.com/Xelltis/udonarium_axe_backend/commit/bf0ace137b9e7b8a7fbf02e88f0c4080243b69c1))
* **rooms:** stop minding what a seat was told had gone once another seat brings it back ([0f51b15](https://github.com/Xelltis/udonarium_axe_backend/commit/0f51b15d07a84cd906980a30a823470dd3a77f58))
* **rooms:** tell a seat its deletion of something handed back to it went through ([9ec851b](https://github.com/Xelltis/udonarium_axe_backend/commit/9ec851b5febebf23d70bb5bc31ed3f6dda2bfa7b))
* stop publishing the repository as static assets, and harden the setup ([6973333](https://github.com/Xelltis/udonarium_axe_backend/commit/6973333595bfd4d42875363d110c8d8c5a93a300))
* **vercel:** answer 400 to a WebSocket request whose Host makes no URL ([73c065c](https://github.com/Xelltis/udonarium_axe_backend/commit/73c065ccb6de98f790570abc665bf8abdf651cdf))
* **vercel:** answer a malformed JSON body with 400 instead of 500 ([1f66ec7](https://github.com/Xelltis/udonarium_axe_backend/commit/1f66ec7b081b29ba535f2ed5eb71bbdd1e3e3d4b))
* **vercel:** ask a socket that reaches a room let go but still heard to come back ([0038e2c](https://github.com/Xelltis/udonarium_axe_backend/commit/0038e2c0446168b8ba5b48f8fdb4c03cbc5ff0d3))
* **vercel:** ask sockets elsewhere back after the last call, and log when that fails ([bb4b282](https://github.com/Xelltis/udonarium_axe_backend/commit/bb4b2825cc034a2037d6a60398be9c0d44af6bf4))
* **vercel:** close a relayed socket to rotate only once what it sent has reached the owner ([db7c779](https://github.com/Xelltis/udonarium_axe_backend/commit/db7c7799590f5575013039be0b03de518fed5285))
* **vercel:** count relayed pings against the frame limit, and space those passed on ([66b34d2](https://github.com/Xelltis/udonarium_axe_backend/commit/66b34d25299b3067d478f90d6fa4f4b603c95241))
* **vercel:** give the app the https URL when Vercel ended TLS in front ([dba13a3](https://github.com/Xelltis/udonarium_axe_backend/commit/dba13a37a81d555ad7c37784cc6ad9ac5611fe8a))
* **vercel:** keep a large object's older version whole when its rewrite stops partway ([dcd2fd0](https://github.com/Xelltis/udonarium_axe_backend/commit/dcd2fd000c90bee8e547e94654d97f2eb1d1e6ba))
* **vercel:** let a room go as work that goes on after the last call ([c085d5a](https://github.com/Xelltis/udonarium_axe_backend/commit/c085d5aa1699041b1775841406c7c59683700760))
* **vercel:** let a room go only once it is heard, and claim afresh one let go while waited for ([b204814](https://github.com/Xelltis/udonarium_axe_backend/commit/b2048146f798d9d296c76d0aa6862f2276a60b44))
* **vercel:** listen again on a channel only once the last stop of listening there is through ([5d19ea8](https://github.com/Xelltis/udonarium_axe_backend/commit/5d19ea84f0392c0685141ac7d202518573ed7744))
* **vercel:** open a room even when a write cut short left an object's parts missing ([15fc4ed](https://github.com/Xelltis/udonarium_axe_backend/commit/15fc4ed96616159c38d699812a664cf05752e111))
* **vercel:** pass a relayed socket's ping on to the instance holding the room ([e87171a](https://github.com/Xelltis/udonarium_axe_backend/commit/e87171aa2e8bff11304f7bb6e5ab495352325762))
* **vercel:** send what goes to a socket elsewhere in order, a frame in parts before the next ([28b6f1a](https://github.com/Xelltis/udonarium_axe_backend/commit/28b6f1af408b3684abfbad761f501d27e860f9f0))
* **vercel:** sweep only once in a while when no CRON_SECRET guards the sweep ([0426bb9](https://github.com/Xelltis/udonarium_axe_backend/commit/0426bb9ee8511bef03a8c417f201d62879862fc8))
* **vercel:** take a seat that left out of the copy other instances read, and clear stale ones ([c368a80](https://github.com/Xelltis/udonarium_axe_backend/commit/c368a80255c14236ba52b7a0dbab1d6631319051))
* **vercel:** tell the owner to delete a room on a channel only the owner hears ([1284f06](https://github.com/Xelltis/udonarium_axe_backend/commit/1284f0634396814ba8523310bbd3a497d738ec2d))
* **vercel:** try listening to the relay again after a start that failed ([0365977](https://github.com/Xelltis/udonarium_axe_backend/commit/0365977fb930b2e8ae08905c6c76d0e303c18abf))
* **vercel:** turn away channel and peer names that widen the token ([5671e9f](https://github.com/Xelltis/udonarium_axe_backend/commit/5671e9ffb506391e7c035bb25412ee646922754b))


### Features

* **cloudflare:** add a content-addressed asset store on Workers and R2 ([0e6653c](https://github.com/Xelltis/udonarium_axe_backend/commit/0e6653c5fcae82645ce2b79113d8fd8da487d2bb))
* **cloudflare:** ask for login to upload, and keep taken-down assets out ([d98e18f](https://github.com/Xelltis/udonarium_axe_backend/commit/d98e18f061d61b656dcfa83f4630c2b138c057b1))
* **cloudflare:** find one room by its key, past what the list shows ([02ac985](https://github.com/Xelltis/udonarium_axe_backend/commit/02ac985e8af154d31dce4386e51814316f5cac32))
* **cloudflare:** hand back a room asset's name with its bytes ([de6e299](https://github.com/Xelltis/udonarium_axe_backend/commit/de6e2997380a48cdf4ef2ce05683be20fe9db84d))
* **cloudflare:** issue SkyWay tokens beside the room server, for Axe delivered with SkyWay ([78c42f3](https://github.com/Xelltis/udonarium_axe_backend/commit/78c42f3d7a1537d6b41883f8e5b50671e1d09f5e))
* **cloudflare:** keep a login fresh over the socket and drop seats whose login ran out ([7fe381f](https://github.com/Xelltis/udonarium_axe_backend/commit/7fe381fe538d8403ff59664571f2ff48519219e4))
* **cloudflare:** keep hidden things from those who may not see them ([738e5ed](https://github.com/Xelltis/udonarium_axe_backend/commit/738e5ed9af3a2a6455338d538dc9a8bfb237ad00))
* **cloudflare:** keep pictures and sounds in their room, for its seats only ([c49afa0](https://github.com/Xelltis/udonarium_axe_backend/commit/c49afa0223b62fbbc6db6140aa6ee712ce9e1e8d))
* **cloudflare:** let a room's GM delete it, and mark such rooms in the list ([4ebd635](https://github.com/Xelltis/udonarium_axe_backend/commit/4ebd6350041c795b7920f4cbed18f43863f67b39))
* **cloudflare:** list a room's assets, with the names they were put up under ([4e3c683](https://github.com/Xelltis/udonarium_axe_backend/commit/4e3c683c0548c6e40f3c34f659d7467bce346c24))
* **cloudflare:** log in with Discord and have the room server hand out roles ([c8ac7e0](https://github.com/Xelltis/udonarium_axe_backend/commit/c8ac7e0f5445424b9dc9626eb6353a1269765c2c))
* **cloudflare:** name the close code that asks a seat back on another link ([244c76d](https://github.com/Xelltis/udonarium_axe_backend/commit/244c76de86073e309b930aaffbb7f149f6e9b129))
* **cloudflare:** name the rate window in the contract ([e523bbc](https://github.com/Xelltis/udonarium_axe_backend/commit/e523bbc2fa73ea509a408593a435ff5336ea44c8))
* **cloudflare:** roll chat dice on the server with BCDice ([daa1fb8](https://github.com/Xelltis/udonarium_axe_backend/commit/daa1fb8ce83b9b3d0913fbf55c97ce3e966c233c))
* **cloudflare:** run each room in a Durable Object that relays and keeps the table ([b4e94fe](https://github.com/Xelltis/udonarium_axe_backend/commit/b4e94fe9f9eda77437fa2c89581d60d2980cc678))
* **cloudflare:** say the seat's role with every asset token ([3669d59](https://github.com/Xelltis/udonarium_axe_backend/commit/3669d5975d5155d47e602a5ac1160bea599bb7e0))
* **cloudflare:** sweep expired assets out as new ones come in ([353a734](https://github.com/Xelltis/udonarium_axe_backend/commit/353a734d9af50bb233397571cc9682eb7885bc2b))
* **cloudflare:** take SVG and serve it in a sandbox ([1ed792f](https://github.com/Xelltis/udonarium_axe_backend/commit/1ed792fd4d32d2eb759bdf8e550919415070b12a))
* **cloudflare:** write room events to Workers Analytics Engine ([614b1ff](https://github.com/Xelltis/udonarium_axe_backend/commit/614b1ff6d554a1d0fa804b47f01002a54da66c87))
* put assets too big for one request straight into the store ([997c4b1](https://github.com/Xelltis/udonarium_axe_backend/commit/997c4b1c875e8a4ffe45e9e2ede395b216a7aaca))
* **rooms:** let out a seat left alone for three hours, as Axe tells by active ([944ff59](https://github.com/Xelltis/udonarium_axe_backend/commit/944ff59dd38a0bb73beb42fecebf859436e6c21b))
* **vercel:** count requests and keep accounts in Redis ([407f755](https://github.com/Xelltis/udonarium_axe_backend/commit/407f75580fb344d2966c093b7d473da2ddace778))
* **vercel:** forward a room's sockets between instances ([2dd0c7c](https://github.com/Xelltis/udonarium_axe_backend/commit/2dd0c7c3cb1140af40b9f219999314265c678d61))
* **vercel:** keep a room's objects in Redis ([d742d81](https://github.com/Xelltis/udonarium_axe_backend/commit/d742d819f56c895fbd524f72b5769baa8c65268a))
* **vercel:** keep room assets in Vercel Blob and serve rooms from the function ([7fbf6ef](https://github.com/Xelltis/udonarium_axe_backend/commit/7fbf6efee82111e11d3a695accef04eca5a634f7))
* **vercel:** keep the lobby in Redis ([07e647c](https://github.com/Xelltis/udonarium_axe_backend/commit/07e647c2986089d2d508bcc6752a4136d2957134))
* **vercel:** run a room on the instance that holds its lease ([803a5c2](https://github.com/Xelltis/udonarium_axe_backend/commit/803a5c27b903519f0d8e8839ced170bed8aa06ea))
* **vercel:** sweep rooms past their time ([1e19629](https://github.com/Xelltis/udonarium_axe_backend/commit/1e1962976e70456cf8aa46e8d272b76c17b84f24))


### Performance Improvements

* **cloudflare:** serve repeat reads from the data centre's cache ([e261d34](https://github.com/Xelltis/udonarium_axe_backend/commit/e261d342f06f0a69914dec0fde436159ffe6f754))
* **cloudflare:** stream uploads into R2 instead of holding them ([278448c](https://github.com/Xelltis/udonarium_axe_backend/commit/278448c43b0064fd897f18347ba659cb586d26d1))

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
