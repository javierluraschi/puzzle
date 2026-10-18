FROM php:8.3-cli-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends git unzip curl tini libpng-dev libjpeg62-turbo-dev libwebp-dev libfreetype6-dev \
 && docker-php-ext-configure gd --with-jpeg --with-webp --with-freetype \
 && docker-php-ext-install -j"$(nproc)" gd opcache \
 && rm -rf /var/lib/apt/lists/*

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
COPY docker/php.ini /usr/local/etc/php/conf.d/zz-app.ini

WORKDIR /app
COPY composer.json composer.lock* ./
RUN composer install --no-dev --no-interaction --no-progress --prefer-dist \
 && composer clear-cache

# On-device segmentation: ONNX Runtime Web + MobileSAM (Acly/MobileSAM ONNX export, MIT),
# served from this app so the browser can cache them and run cross-origin isolated
ARG ORT_VERSION=1.30.0
RUN mkdir -p public/vendor/ort public/models \
 && cd public/vendor/ort \
 && for f in ort.webgpu.min.mjs ort-wasm-simd-threaded.asyncify.mjs ort-wasm-simd-threaded.asyncify.wasm; do \
      curl -fsSL -o "$f" "https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/$f"; done \
 && cd ../../models \
 && curl -fsSL -o mobile_sam_image_encoder.onnx https://huggingface.co/Acly/MobileSAM/resolve/main/mobile_sam_image_encoder.onnx \
 && curl -fsSL -o sam_mask_decoder_multi.onnx https://huggingface.co/Acly/MobileSAM/resolve/main/sam_mask_decoder_multi.onnx \
 && cd /app/public \
 && printf '%s\n' \
    "3dffff71811bc13a3a3d9591c57ca5ee5735b8f5f3eaf789510b02bb040ae3a0  vendor/ort/ort.webgpu.min.mjs" \
    "3d1c85995364bb643302fc6fd877a0c3ba5ae72401815e0f24828a53d9191e28  vendor/ort/ort-wasm-simd-threaded.asyncify.mjs" \
    "39f9f0894d478800487ed9f7dbe92618498db320cf55c8e3d89adff8dce658da  vendor/ort/ort-wasm-simd-threaded.asyncify.wasm" \
    "580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749  models/mobile_sam_image_encoder.onnx" \
    "8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe  models/sam_mask_decoder_multi.onnx" \
  | sha256sum -c -

COPY server ./server
COPY public ./public

ENV DATA_DIR=/data \
    PHP_CLI_SERVER_WORKERS=6 \
    SOLVER_WORKERS=2
RUN mkdir -p /data
EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["php", "-S", "0.0.0.0:8080", "-t", "public", "server/router.php"]
