<?php

declare(strict_types=1);

/**
 * A utility class that creates auth tokens (JWTs) for SkyWay 2023.
 *
 * It creates HS256-signed JWTs with the same structure and signing method as the
 * TypeScript implementation (udonarium-backend-vercel).
 */
final class SkywayAuth
{
    /** @codeCoverageIgnore */
    private function __construct() {}

    /** How long a token lasts, in seconds: 24 hours. */
    private const int EXPIRY_SECONDS = 86400;

    /**
     * The reserved prefix for lobby channel names.
     *
     * The lobby scope does not allow publication / subscription, on purpose, so a client must be
     * kept from asking for a channel name with this prefix and getting the room scope
     * (publication / subscription = write).
     */
    public const string LOBBY_CHANNEL_PREFIX = 'udonarium-lobby-';

    /**
     * Creates a JWT for SkyWay 2023.
     *
     * Returns a token with scopes for both the lobby channels and the room channel.
     * It expires 24 hours after the time it is issued.
     *
     * @param string      $appId       The SkyWay application id.
     * @param string      $secret      The secret key the HMAC-SHA256 signature is made with.
     * @param int         $lobbySize   How many lobby channels there are at most.
     * @param string      $channelName The name of the room channel.
     * @param string      $peerId      The peer id.
     * @param string|null $jti         The JWT id (a UUID v4 is created for it when null).
     * @param int|null    $iat         When issued, as a Unix timestamp (the current time when null).
     *
     * @return string The Base64URL-encoded JWT string.
     *
     * @throws \JsonException When JSON encoding fails.
     */
    public static function generate(
        string  $appId,
        string  $secret,
        int     $lobbySize,
        string  $channelName,
        string  $peerId,
        ?string $jti = null,
        ?int    $iat = null,
    ): string {
        $jti = $jti ?? self::generateUuid();
        $iat = $iat ?? time();

        $payload = [
            'jti'     => $jti,
            'iat'     => $iat,
            'exp'     => $iat + self::EXPIRY_SECONDS,
            'version' => 2,
            'scope'   => [
                'app' => [
                    'id'       => $appId,
                    'turn'     => true,
                    'actions'  => ['read'],
                    'channels' => [
                        self::buildChannelScope(self::LOBBY_CHANNEL_PREFIX . "*-of-{$lobbySize}", $peerId, lobby: true),
                        self::buildChannelScope($channelName, $peerId, lobby: false),
                    ],
                ],
            ],
        ];

        return self::encodeJwt($payload, $secret);
    }

    /**
     * Builds a channel scope.
     *
     * @param string $name  The channel name.
     * @param string $peerId The peer id.
     * @param bool   $lobby  Whether it is a lobby channel.
     *
     * @return array<string, mixed> The SkyWay channel scope.
     */
    private static function buildChannelScope(string $name, string $peerId, bool $lobby): array
    {
        $members = [
            [
                'name'         => $peerId,
                'actions'      => ['write'],
                'publication'  => ['actions' => $lobby ? [] : ['write']],
                'subscription' => ['actions' => $lobby ? [] : ['write']],
            ],
        ];

        if (!$lobby) {
            $members[] = [
                'name'         => '*',
                'actions'      => ['signal'],
                'publication'  => ['actions' => []],
                'subscription' => ['actions' => []],
            ];
        }

        return [
            'name'    => $name,
            'actions' => ['read', 'create'],
            'members' => $members,
        ];
    }

    /**
     * Creates an HS256-signed JWT from a payload.
     *
     * @param array<string, mixed> $payload The JWT payload.
     * @param string               $secret  The HMAC-SHA256 signing key.
     *
     * @return string The JWT string.
     *
     * @throws \JsonException When JSON encoding fails.
     */
    private static function encodeJwt(array $payload, string $secret): string
    {
        $flags = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR;

        $header    = self::base64UrlEncode((string) json_encode(['alg' => 'HS256', 'typ' => 'JWT'], $flags));
        $body      = self::base64UrlEncode((string) json_encode($payload, $flags));
        $signature = self::base64UrlEncode(
            (string) hash_hmac('sha256', $header . '.' . $body, $secret, true),
        );

        return $header . '.' . $body . '.' . $signature;
    }

    /**
     * Encodes in Base64URL.
     *
     * Following RFC 4648 §5, it strips the padding and replaces "+" with "-" and "/" with "_".
     *
     * @param string $data The binary data to encode.
     *
     * @return string The Base64URL-encoded string.
     */
    private static function base64UrlEncode(string $data): string
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }

    /**
     * Creates a UUID that conforms to RFC 4122 v4.
     *
     * @return string The UUID as a 36-character string, with hyphens between its parts.
     */
    private static function generateUuid(): string
    {
        $data    = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
