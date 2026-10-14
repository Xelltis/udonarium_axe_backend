<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * {@see SkywayAuth} のテストケース。
 *
 * JWT の構造（3 パート）、ヘッダー、ペイロードの各フィールド、
 * HMAC-SHA256 署名の検証、チャネル/ロビー/ピアの設定を網羅的にテストする。
 */
class SkywayAuthTest extends TestCase
{
    /**
     * Base64URL エンコードされた文字列をデコードする。
     *
     * @param  string $input Base64URL エンコード文字列
     * @return string デコード済みバイト列
     */
    private function base64UrlDecode(string $input): string
    {
        $base64  = strtr($input, '-_', '+/');
        $base64  = str_pad($base64, (int) (ceil(strlen($base64) / 4) * 4), '=');
        $decoded = base64_decode($base64, true);
        return $decoded !== false ? $decoded : '';
    }

    /**
     * JWT の指定部分（header=0, payload=1）をデコードして配列で返す。
     *
     * @param  string $token JWT 文字列
     * @param  int    $part  0=ヘッダー, 1=ペイロード
     * @return array<string, mixed> デコードされた連想配列
     */
    private function decodeJwtPart(string $token, int $part): array
    {
        $parts  = explode('.', $token);
        $result = json_decode($this->base64UrlDecode($parts[$part]), true);
        return is_array($result) ? $result : [];
    }

    /**
     * generate() が 3 パート（header.payload.signature）の JWT を返すことを確認する。
     */
    public function testGenerateReturnsThreePartJwt(): void
    {
        $token = SkywayAuth::generate(
            appId: 'test-app-id',
            secret: 'test-secret',
            lobbySize: 3,
            channelName: 'test-channel',
            peerId: 'test-peer',
            jti: 'fixed-jti',
            iat: 1700000000,
        );
        $this->assertCount(3, explode('.', $token));
    }

    /**
     * JWT ヘッダーの alg が HS256、typ が JWT であることを確認する。
     */
    public function testGenerateHeaderIsCorrect(): void
    {
        $token  = SkywayAuth::generate(
            appId: 'test-app-id',
            secret: 'test-secret',
            lobbySize: 3,
            channelName: 'test-channel',
            peerId: 'test-peer',
            jti: 'fixed-jti',
            iat: 1700000000,
        );
        $header = $this->decodeJwtPart($token, 0);

        $this->assertSame('HS256', $header['alg']);
        $this->assertSame('JWT', $header['typ']);
    }

    /**
     * ペイロードに jti・iat・exp・version の必須フィールドが正しく含まれることを確認する。
     */
    public function testGeneratePayloadHasRequiredFields(): void
    {
        $iat     = 1700000000;
        $token   = SkywayAuth::generate(
            appId: 'test-app-id',
            secret: 'test-secret',
            lobbySize: 3,
            channelName: 'test-channel',
            peerId: 'test-peer',
            jti: 'fixed-jti',
            iat: $iat,
        );
        $payload = $this->decodeJwtPart($token, 1);

        $this->assertSame('fixed-jti', $payload['jti']);
        $this->assertSame($iat, $payload['iat']);
        $this->assertSame($iat + 86400, $payload['exp']);
        $this->assertSame(2, $payload['version']);
    }

    /**
     * JWT の署名部分が HMAC-SHA256 で正しく検証可能であることを確認する。
     */
    public function testGenerateSignatureIsVerifiable(): void
    {
        $secret = 'test-secret';
        $token  = SkywayAuth::generate(
            appId: 'test-app-id',
            secret: $secret,
            lobbySize: 3,
            channelName: 'test-channel',
            peerId: 'test-peer',
            jti: 'fixed-jti',
            iat: 1700000000,
        );
        [$headerB64, $payloadB64, $sigB64] = explode('.', $token);

        $expectedSig = rtrim(
            strtr(
                base64_encode(
                    (string) hash_hmac('sha256', $headerB64 . '.' . $payloadB64, $secret, true),
                ),
                '+/',
                '-_',
            ),
            '=',
        );

        $this->assertSame($expectedSig, $sigB64);
    }

    /**
     * 指定した channelName がルームチャネルスコープに含まれることを確認する。
     */
    public function testGenerateChannelNameIsInRoomChannelScope(): void
    {
        $token   = SkywayAuth::generate(
            appId: 'test-app-id',
            secret: 'test-secret',
            lobbySize: 3,
            channelName: 'my-room',
            peerId: 'test-peer',
            jti: 'fixed-jti',
            iat: 1700000000,
        );
        $payload  = $this->decodeJwtPart($token, 1);
        /** @var array{scope: array{app: array{channels: array<int, array<string, mixed>>}}} $payload */
        $channels = $payload['scope']['app']['channels'];
        /** @var array<int, array<string, mixed>> $channels */
        $names    = array_column($channels, 'name');
        $this->assertContains('my-room', $names);
    }

    /**
     * lobbySize がロビーチャネル名に反映されることを確認する。
     */
    public function testGenerateLobbySizeIsReflectedInLobbyChannelName(): void
    {
        $token   = SkywayAuth::generate(
            appId: 'test-app-id',
            secret: 'test-secret',
            lobbySize: 5,
            channelName: 'test-channel',
            peerId: 'test-peer',
            jti: 'fixed-jti',
            iat: 1700000000,
        );
        $payload  = $this->decodeJwtPart($token, 1);
        /** @var array{scope: array{app: array{channels: array<int, array<string, mixed>>}}} $payload */
        $channels = $payload['scope']['app']['channels'];
        /** @var array<int, array<string, mixed>> $channels */
        $names    = array_column($channels, 'name');
        $this->assertContains('udonarium-lobby-*-of-5', $names);
    }

    /**
     * 指定した peerId がすべてのチャネルのメンバーに含まれることを確認する。
     */
    public function testGeneratePeerIdAppearsInEveryChannel(): void
    {
        $token   = SkywayAuth::generate(
            appId: 'test-app-id',
            secret: 'test-secret',
            lobbySize: 3,
            channelName: 'test-channel',
            peerId: 'peer-xyz',
            jti: 'fixed-jti',
            iat: 1700000000,
        );
        $payload  = $this->decodeJwtPart($token, 1);
        /** @var array{scope: array{app: array{channels: array<int, array{members: array<int, array<string, mixed>>}>}}} $payload */
        $channels = $payload['scope']['app']['channels'];
        /** @var array<int, array{members: array<int, array<string, mixed>>}> $channels */
        foreach ($channels as $channel) {
            $memberNames = array_column($channel['members'], 'name');
            $this->assertContains('peer-xyz', $memberNames);
        }
    }

    /**
     * 指定した appId がスコープの app.id に設定されることを確認する。
     */
    public function testGenerateAppIdIsInScope(): void
    {
        $token   = SkywayAuth::generate(
            appId: 'my-app-123',
            secret: 'test-secret',
            lobbySize: 3,
            channelName: 'test-channel',
            peerId: 'test-peer',
            jti: 'fixed-jti',
            iat: 1700000000,
        );
        $payload = $this->decodeJwtPart($token, 1);
        /** @var array{scope: array{app: array{id: string}}} $payload */
        $app = $payload['scope']['app'];
        $this->assertSame('my-app-123', $app['id']);
    }

    /**
     * iat を省略した場合に現在時刻が自動的に使用されることを確認する。
     */
    public function testGenerateUsesCurrentTimeWhenIatNotProvided(): void
    {
        $before  = time();
        $token   = SkywayAuth::generate(
            appId: 'app',
            secret: 'secret',
            lobbySize: 3,
            channelName: 'ch',
            peerId: 'peer',
        );
        $after   = time();
        $payload = $this->decodeJwtPart($token, 1);

        $this->assertGreaterThanOrEqual($before, $payload['iat']);
        $this->assertLessThanOrEqual($after, $payload['iat']);
    }

    /**
     * 異なる secret を使用した場合に異なる署名が生成されることを確認する。
     */
    public function testGenerateDifferentSecretsProduceDifferentSignatures(): void
    {
        $token1 = SkywayAuth::generate(
            appId: 'a',
            secret: 'secret-A',
            lobbySize: 3,
            channelName: 'ch',
            peerId: 'p',
            jti: 'j',
            iat: 1700000000,
        );
        $token2 = SkywayAuth::generate(
            appId: 'a',
            secret: 'secret-B',
            lobbySize: 3,
            channelName: 'ch',
            peerId: 'p',
            jti: 'j',
            iat: 1700000000,
        );

        $sig1 = explode('.', $token1)[2];
        $sig2 = explode('.', $token2)[2];
        $this->assertNotSame($sig1, $sig2);
    }

    /**
     * jti を null（デフォルト）で呼び出した場合に UUID v4 形式の jti が生成されることを確認する。
     */
    public function testGenerateAutoGeneratesUuidWhenJtiIsNull(): void
    {
        $token   = SkywayAuth::generate(
            appId: 'app',
            secret: 'secret',
            lobbySize: 3,
            channelName: 'ch',
            peerId: 'peer',
            iat: 1700000000,
        );
        $payload = $this->decodeJwtPart($token, 1);

        $jti = $payload['jti'];
        $this->assertIsString($jti);
        $this->assertMatchesRegularExpression(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/',
            $jti,
        );
    }
}
