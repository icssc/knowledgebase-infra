#!/usr/bin/env bash
while getopts 'a:i:s:' opt; do
  case "$opt" in
    a)
      APP_URL="$OPTARG"
      ;;
    i)
      GOOGLE_APP_ID="$OPTARG"
      ;;
    s)
      GOOGLE_APP_SECRET="$OPTARG"
      ;;
    ?|h)
      echo "Usage: $(basename $0) -a [app URL] -i [Google OAuth App ID] -s [Google OAuth App Secret]"
      exit 1
      ;;
  esac
done

shift "$(($OPTIND -1))"

if [[ -z ${APP_URL} || -z ${GOOGLE_APP_ID} || -z ${GOOGLE_APP_SECRET} ]]; then
  echo "Required environment variables not provided. Stop."
  exit 1
fi

# Enable debugging.
set -x

# Enable more stringent abort conditions.
set -o errexit
set -o nounset
set -o pipefail

# Install dependencies for BookStack.
dnf install --assumeyes --setopt=install_weak_deps=True \
  composer \
  git \
  httpd \
  mariadb105-server \
  php8.2 \
  php8.2-gd \
  php8.2-mysqlnd \
  php8.2-pdo \
  sendmail

# Nuke default httpd directories.
pushd /var/www
rm --recursive --force cgi-bin
rm --recursive --force html

# Set up httpd.
cat > /etc/httpd/conf/httpd.conf << EOF
ServerRoot /etc/httpd
Listen 80
Include conf.modules.d/*.conf
User apache
Group apache
ServerAdmin root@localhost
<Directory />
  AllowOverride none
  Require all denied
</Directory>
DocumentRoot /var/www/bookstack/public/
<Directory /var/www/bookstack/public/>
  Options Indexes FollowSymLinks
  AllowOverride None
  Require all granted
  <IfModule mod_rewrite.c>
    <IfModule mod_negotiation.c>
      Options -MultiViews -Indexes
    </IfModule>
    RewriteEngine On
    RewriteCond %{HTTP:Authorization} .
    RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
    RewriteCond %{REQUEST_FILENAME} !-d
    RewriteCond %{REQUEST_URI} (.+)/$
    RewriteRule ^ %1 [L,R=301]
    RewriteCond %{REQUEST_FILENAME} !-d
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteRule ^ index.php [L]
  </IfModule>
</Directory>
<IfModule dir_module>
  DirectoryIndex index.html
</IfModule>
<Files ".ht*">
  Require all denied
</Files>
ErrorLog logs/error_log
LogLevel warn
<IfModule log_config_module>
  LogFormat "%h %l %u %t \"%r\" %>s %b \"%{Referer}i\" \"%{User-Agent}i\"" combined
  LogFormat "%h %l %u %t \"%r\" %>s %b" common
  <IfModule logio_module>
    LogFormat "%h %l %u %t \"%r\" %>s %b \"%{Referer}i\" \"%{User-Agent}i\" %I %O" combinedio
  </IfModule>
  CustomLog "logs/access_log" combined
</IfModule>
<IfModule alias_module>
  ScriptAlias /cgi-bin/ /var/www/cgi-bin/
</IfModule>
<Directory /var/www/cgi-bin>
  AllowOverride None
  Options None
  Require all granted
</Directory>
<IfModule mime_module>
  TypesConfig /etc/mime.types
  AddType application/x-compress .Z
  AddType application/x-gzip .gz .tgz
  AddType text/html .shtml
  AddOutputFilter INCLUDES .shtml
</IfModule>
AddDefaultCharset UTF-8
<IfModule mime_magic_module>
  MIMEMagicFile conf/magic
</IfModule>
EnableSendfile on
IncludeOptional conf.d/*.conf
EOF

# Clone BookStack repository.
git clone https://github.com/BookStackApp/BookStack.git --branch release --single-branch bookstack
pushd bookstack

# Run composer install.
mkdir -p /root/.config/composer
COMPOSER_ALLOW_SUPERUSER=1 COMPOSER_HOME="/root/.config/composer" composer install --no-dev

# Generate database password.
DB_PASSWORD="$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 20 || { CODE=$?; [ $CODE -eq 141 ] && true || (exit $CODE); })"

# Populate .env and generate application key.
cat > .env << EOF
APP_KEY=
APP_URL=${APP_URL}
DB_HOST=localhost
DB_DATABASE=bookstack
DB_USERNAME=bookstack
DB_PASSWORD=${DB_PASSWORD}
MAIL_FROM_NAME=no-reply
MAIL_FROM=noreply@localhost.localdomain
GOOGLE_AUTO_REGISTER=true
GOOGLE_AUTO_CONFIRM_EMAIL=true
GOOGLE_APP_ID=${GOOGLE_APP_ID}
GOOGLE_APP_SECRET=${GOOGLE_APP_SECRET}
EOF
php artisan key:generate --no-interaction --force

# Set filesystem permissions.
chown -R root:apache .
chmod -R 755 .
chmod -R 775 storage bootstrap/cache public/uploads
chmod 640 .env
git config core.fileMode false

# Start and enable services.
systemctl enable --now httpd.service
systemctl enable --now mariadb.service

# Initialize database.
mariadb -u root << EOF
CREATE USER "bookstack"@"%" IDENTIFIED BY "${DB_PASSWORD}";
CREATE DATABASE bookstack;
GRANT ALL PRIVILEGES ON bookstack.* TO "bookstack"@"%";
EOF
php artisan migrate --no-interaction --force

# Return to $PWD.
pushd -0 && dirs -c

# Disable debugging and abort conditions.
set +o pipefail
set +o nounset
set +o errexit
set +x
