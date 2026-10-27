FROM php:8.5.12-apache

# Enables mod_rewrite.
RUN a2enmod rewrite

# The Apache virtual host setting that lets .htaccess change the configuration.
RUN sed -i 's/AllowOverride None/AllowOverride All/g' /etc/apache2/apache2.conf

# Installs the packages Composer needs.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    unzip \
    libzip-dev \
    && docker-php-ext-install zip \
    && rm -rf /var/lib/apt/lists/*

# Installs PCOV (for measuring code coverage). It is always enabled in this image, not only for tests.
RUN pecl install pcov && docker-php-ext-enable pcov

# Installs Composer.
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

# Sets the document root to the project root.
ENV APACHE_DOCUMENT_ROOT=/var/www/html
