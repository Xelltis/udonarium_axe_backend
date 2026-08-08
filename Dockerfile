FROM php:8.5.9-apache

# mod_rewrite を有効化
RUN a2enmod rewrite

# .htaccess による設定変更を許可する Apache バーチャルホスト設定
RUN sed -i 's/AllowOverride None/AllowOverride All/g' /etc/apache2/apache2.conf

# Composer が必要とするパッケージをインストール
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    unzip \
    libzip-dev \
    && docker-php-ext-install zip \
    && rm -rf /var/lib/apt/lists/*

# PCOV をインストール（コードカバレッジ計測用・テスト時のみ有効化）
RUN pecl install pcov && docker-php-ext-enable pcov

# Composer をインストール
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

# ドキュメントルートをプロジェクトルートに設定
ENV APACHE_DOCUMENT_ROOT=/var/www/html
