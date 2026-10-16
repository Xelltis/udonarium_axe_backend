<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * Test cases for {@see SkywayAuth}.
 *
 * They test thoroughly the JWT's structure (three parts), its header, each field of the payload,
 * the check of the HMAC-SHA256 signature, and the settings for channels, the lobby and peers.
 */
class SkywayAuthTest extends TestCase
{
    /**
     * Decodes a Base64URL-encoded string.
     *
     * @param  string $input The Base64URL-encoded string.
     * @return string The decoded bytes.
     */
    private function base64UrlDecode(string $input): string
    {
        $base64  = strtr($input, '-_', '+/');
        $base64  = str_pad($base64, (int) (ceil(strlen($base64) / 4) * 4), '=');
        $decoded = base64_decode($base64, true);
        return $decoded !== false ? $decoded : '';
    }

    /**
     * Decodes the given part of a JWT (header=0, payload=1) and returns it as an array.
     *
     * @param  string $token The JWT string.
     * @param  int    $part  0=header, 1=payload.
     * @return array<string, mixed> The decoded associative array.
     */
    private function decodeJwtPart(string $token, int $part): array
    {
        $parts  = explode('.', $token);
        $result = json_decode($this->base64UrlDecode($parts[$part]), true);
        return is_array($result) ? $result : [];
    }

    /**
     * Checks that generate() returns a JWT in three parts (header.payload.signature).
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
     * Checks that the JWT header's alg is HS256 and its typ is JWT.
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
     * Checks that the payload correctly holds the required fields jti, iat, exp and version.
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
     * Checks that the JWT's signature can be verified correctly with HMAC-SHA256.
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
     * Checks that the given channelName is in the room channel scope.
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
     * Checks that lobbySize shows in the lobby channel name.
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
     * Checks that the given peerId is among the members of every channel.
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
     * Checks that the given appId is set as app.id in the scope.
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
     * Checks that the current time is used automatically when iat is left out.
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
     * Checks that different secrets give different signatures.
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
     * Checks that a jti in UUID v4 form is created when jti is null (the default).
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
