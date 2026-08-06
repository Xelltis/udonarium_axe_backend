<?php

declare(strict_types=1);

/**
 * SkyWay 2023 用の認証トークン（JWT）を生成するユーティリティクラス。
 *
 * TypeScript 実装（udonarium-backend-vercel）と同一の構造・署名方式で
 * HS256 署名付き JWT を生成する。
 */
final class SkywayAuth
{
    /** @codeCoverageIgnore */
    private function __construct() {}

    /** トークンの有効期間（秒）: 24 時間 */
    private const int EXPIRY_SECONDS = 86400;

    /**
     * ロビーチャンネル名の予約プレフィックス。
     *
     * ロビースコープは publication / subscription を意図的に許可していないため、
     * クライアントがこのプレフィックスのチャンネル名を要求してルームスコープ
     * （publication / subscription = write）を得ることを防ぐ必要がある。
     */
    public const string LOBBY_CHANNEL_PREFIX = 'udonarium-lobby-';

    /**
     * SkyWay 2023 用の JWT トークンを生成する。
     *
     * ロビーチャンネルとルームチャンネルの両方に対するスコープを含む
     * トークンを返す。有効期限は発行時刻から 24 時間。
     *
     * @param string      $appId       SkyWay アプリケーション ID
     * @param string      $secret      HMAC-SHA256 署名に使用するシークレットキー
     * @param int         $lobbySize   ロビーチャンネルの最大数
     * @param string      $channelName ルームチャンネル名
     * @param string      $peerId      ピア ID
     * @param string|null $jti         JWT ID（null の場合は UUID v4 を自動生成）
     * @param int|null    $iat         発行時刻 Unix タイムスタンプ（null の場合は現在時刻）
     *
     * @return string Base64URL エンコードされた JWT 文字列
     *
     * @throws \JsonException JSON エンコードに失敗した場合
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
     * チャンネルスコープを構築する。
     *
     * @param string $name  チャンネル名
     * @param string $peerId ピア ID
     * @param bool   $lobby  ロビーチャンネルかどうか
     *
     * @return array<string, mixed> SkyWay チャンネルスコープ
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
     * ペイロードから HS256 署名付き JWT を生成する。
     *
     * @param array<string, mixed> $payload JWT ペイロード
     * @param string               $secret  HMAC-SHA256 署名キー
     *
     * @return string JWT 文字列
     *
     * @throws \JsonException JSON エンコードに失敗した場合
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
     * Base64URL エンコードする。
     *
     * RFC 4648 §5 に従い、パディングを除去し "+" → "-"、"/" → "_" に置換する。
     *
     * @param string $data エンコード対象のバイナリデータ
     *
     * @return string Base64URL エンコードされた文字列
     */
    private static function base64UrlEncode(string $data): string
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }

    /**
     * RFC 4122 v4 準拠の UUID を生成する。
     *
     * @return string ハイフン区切りの 36 文字 UUID 文字列
     */
    private static function generateUuid(): string
    {
        $data    = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
